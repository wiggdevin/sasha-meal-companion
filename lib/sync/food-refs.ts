import type { SupabaseClient } from "@supabase/supabase-js";
import { rethrowAccountChanged, type AccountHandle } from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import { browserClient } from "@/lib/supabase/client";

export type OwnedFoodRef = { id: string; user_food_id: string };
export type AccountFoodSnapshot = {
  foods: { id: string; name: string; per_100g: Record<string, unknown> | null;
    catalog_food_id: number | null; deleted_at: string | null; note: string | null;
    updated_at: string }[];
  prefs: { food_ref_id: string; status: string; role: string | null;
    no_cook: boolean | null; note: string | null; updated_at: string }[];
  refs: OwnedFoodRef[];
  /** The account's family marks (W029, A039); null when they could not be read this pass. */
  memberships?: { name_norm: string; status: "eats" | "avoid" | null; note: string | null; rev: number }[] | null;
};
type RawFoodRow = Omit<AccountFoodSnapshot["foods"][number], "updated_at"> & {
  user_id: string; created_at: string; brand: string | null; ingredients_text: string | null;
  allergen_tags: string[] | null; kind: string; rev: number;
};
type RawPrefRow = AccountFoodSnapshot["prefs"][number] & { user_id: string };

// PostgREST caps each response at 1,000 rows. Keyset paging on each table's unique key
// avoids a skipped row if an earlier row is added or removed between requests.
const SNAPSHOT_PAGE_SIZE = 1000;

async function allSnapshotPages<T, K extends keyof T & string>(
  account: AccountHandle,
  key: K,
  query: (userId: string, after: string | null) =>
    PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  let after: string | null = null;
  for (;;) {
    const result = await withAccount(account, (userId) =>
      query(userId, after));
    if (result.error) throw result.error;
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < SNAPSHOT_PAGE_SIZE) return rows;
    const next = page.at(-1)?.[key];
    if (typeof next !== "string" || (after !== null && next <= after)) {
      throw new Error(`Food snapshot page did not advance ${key}`);
    }
    after = next;
  }
}

/** Direct Foods writes do not enter change_log, so an IDB replay alone cannot hydrate the list. */
export async function loadAccountFoodSnapshot(
  account: AccountHandle, client?: SupabaseClient,
): Promise<AccountFoodSnapshot> {
  const supabase = client ?? browserClient();
  const [foodRows, prefRows] = await Promise.all([
    allSnapshotPages<RawFoodRow, "id">(account, "id", (userId, after) => {
      let query = supabase.from("user_foods")
        .select("id,user_id,name,brand,ingredients_text,allergen_tags,kind,rev,per_100g,catalog_food_id,deleted_at,note,created_at")
        .eq("user_id", userId).order("id", { ascending: true });
      if (after !== null) query = query.gt("id", after);
      return query.limit(SNAPSHOT_PAGE_SIZE);
    }),
    allSnapshotPages<RawPrefRow, "food_ref_id">(account, "food_ref_id", (userId, after) => {
      let query = supabase.from("user_food_prefs")
        .select("food_ref_id,user_id,status,role,no_cook,note,updated_at")
        .eq("user_id", userId).order("food_ref_id", { ascending: true });
      if (after !== null) query = query.gt("food_ref_id", after);
      return query.limit(SNAPSHOT_PAGE_SIZE);
    }),
  ]);
  const memberships = await loadMemberships(account, supabase);
  const ownFoods = foodRows.filter((row) => row.user_id === account.userId);
  const refs = await loadOwnedFoodRefs(account, ownFoods.map((row) => row.id), supabase);
  const repairedFoods = await Promise.all(ownFoods.map(async (row) => {
    if (row.name !== "Whey protein powder" || !row.per_100g
      || typeof row.per_100g !== "object" || Array.isArray(row.per_100g)
      || Object.keys(row.per_100g).length !== 0) return row;
    try {
      const { repairLegacyWheyNutrition } = await import("@/lib/foods/starter-nutrition-repair");
      const expected = await repairLegacyWheyNutrition(account, {
        ...row, per_100g: row.per_100g as Record<string, unknown>,
      }, supabase);
      return expected ? { ...row, per_100g: expected } : row;
    } catch (error) {
      rethrowAccountChanged(error);
      console.warn("Could not repair legacy starter nutrition; will retry on the next sync.");
      return row;
    }
  }));
  return {
    foods: repairedFoods.map((row) => ({ ...row, updated_at: row.created_at })),
    prefs: prefRows.filter((row) => row.user_id === account.userId), refs, memberships,
  };
}

type RawMembershipRow = { user_id: string; name_norm: string; status: unknown; note: unknown; rev: unknown };

/**
 * The account's family marks, owner policy of migration 20261231110000. Best effort: a failed read
 * (or a database without the policy) leaves the mark cache as it is and never fails the pass.
 */
async function loadMemberships(
  account: AccountHandle, supabase: SupabaseClient,
): Promise<AccountFoodSnapshot["memberships"]> {
  try {
    const rows = await allSnapshotPages<RawMembershipRow, "name_norm">(account, "name_norm", (userId, after) => {
      let query = supabase.from("food_membership_revisions").select("user_id,name_norm,status,note,rev")
        .eq("user_id", userId).order("name_norm", { ascending: true });
      if (after !== null) query = query.gt("name_norm", after);
      return query.limit(SNAPSHOT_PAGE_SIZE);
    });
    return rows.flatMap((row) => {
      const rev = Number(row.rev);
      const status = row.status === "eats" || row.status === "avoid" ? row.status
        : row.status === null ? null : undefined;
      if (row.user_id !== account.userId || status === undefined || !Number.isSafeInteger(rev) || rev < 0) return [];
      return [{ name_norm: row.name_norm, status, note: typeof row.note === "string" ? row.note : null, rev }];
    });
  } catch (error) {
    rethrowAccountChanged(error);
    return null;
  }
}

/** The sync feed does not include food_refs; read the account-owned join before projecting prefs. */
export async function loadOwnedFoodRefs(
  account: AccountHandle, foodIds: readonly string[],
  client?: SupabaseClient,
): Promise<OwnedFoodRef[]> {
  if (foodIds.length === 0) return [];
  const supabase = client ?? browserClient();
  const refs: OwnedFoodRef[] = [];
  for (let start = 0; start < foodIds.length; start += 100) {
    const ids = foodIds.slice(start, start + 100);
    const result = await withAccount(account, (userId) => supabase.from("food_refs")
      .select("id,user_food_id,user_foods!inner(user_id)")
      .eq("kind", "user").eq("user_foods.user_id", userId)
      .in("user_food_id", ids));
    if (result.error) throw result.error;
    const wanted = new Set(ids);
    for (const row of result.data ?? []) {
      const owner = Array.isArray(row.user_foods) ? row.user_foods[0] : row.user_foods;
      if (typeof row.id === "string" && typeof row.user_food_id === "string"
        && wanted.has(row.user_food_id) && owner?.user_id === account.userId) {
        refs.push({ id: row.id, user_food_id: row.user_food_id });
      }
    }
  }
  return refs;
}
