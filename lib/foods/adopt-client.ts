/**
 * Bundled foods → the server's food registry (T1, 2026-09-12).
 *
 * A recipe item needs a `food_refs` row — `recipe_items.food_ref_id` is a required FK — and the
 * bundled list, which ships inside the app, has no such row. So a bundled ingredient is adopted
 * into their own foods: one `user_foods` row with a deterministic id (a second tap is the same row,
 * on any device), the bundled per-100 g numbers copied into the nutrient codes the app stores, and
 * its `food_refs` row from the same `get_or_create_food_ref` RPC a catalog food uses.
 *
 * Two writes, on purpose. The upsert above goes straight to the server because the food ref has to
 * come back synchronously for the ingredient the user just tapped; the same row also goes onto the
 * op-log (`user_foods`, kind `update`, aimed at the rev the upsert returned), so a second device
 * replays it instead of only learning about it when it happens to pull that row. The two stand
 * or fall together: if the mirror or the op cannot be written, the adoption reports failure
 * (null) even though the server row landed — the sheet then shows its inline line, and the next
 * tap retries both writes (the upsert is idempotent on the deterministic id).
 *
 * The food deliberately stays out of the Foods tab and the rotation: the tab and the rotation read
 * the legacy `foods` map (`lib/store.ts`), and nothing in the app lists the normalized `user_foods`
 * store, so a mirror row there is invisible to both. `kind: 'custom'` is the schema's own code for
 * a food the user has, not the `recipe` twin the recipes entity mints for itself.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbFood, type DbFood } from "@/lib/food-db";
import { uuidV5 } from "@/lib/foods/uuid5";
import type { NutrientCode } from "@/lib/nutrients/codes";
import { browserClient } from "@/lib/supabase/client";
import {
  accountHandle, assertCurrent, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { META_STORE, openAccountDb, putRow } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";
import { withAccount } from "@/lib/device/account-supabase";

/** Fixed namespace for the derived ids, so the same bundled food always mints the same row. */
const BUNDLED_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const ADOPTED_INDEX_KEY = "adopted_foods";

/** The bundled per-100 g keys → the codes `user_foods.per_100g` and `compute_item_snapshot` read. */
export function per100gFromBundled(food: DbFood): Partial<Record<NutrientCode, number>> {
  return {
    energy_kcal: food.per100g.kcal,
    protein: food.per100g.protein,
    carbohydrate: food.per100g.carbs,
    fat_total: food.per100g.fat,
    fiber_total: food.per100g.fiber,
  };
}

/** A stable text form of a food's numbers: sorted keys, so the same numbers give the same key. */
export function numbersKey(per100g: Partial<Record<NutrientCode, number | null>>): string {
  return JSON.stringify(Object.keys(per100g).sort()
    .map((code) => [code, per100g[code as NutrientCode] ?? null]));
}

/**
 * The `user_foods` id a bundled food is adopted under — RFC 4122 v5, lib/foods/uuid5.ts.
 *
 * With `userId` (every adoption): `bundled:<user>:<id>:<numbers>`. `user_foods.id` is one key
 * across every account, so the old global id let only the FIRST account adopt a bundled food; RLS
 * refused every later one. The numbers are in it too: a food-db update mints a new row instead of
 * rewriting the one earlier recipe items and log entries were computed from.
 *
 * Without `userId`: the legacy global `bundled:<id>` id. Rows adopted under it stay readable
 * through their food refs; it is kept only for callers that key an already-added food by it
 * (components/AddFoodSheet.tsx) and is never written again.
 */
export async function bundledFoodUserId(bundledId: string, userId?: string): Promise<string> {
  if (userId === undefined) return uuidV5(BUNDLED_NAMESPACE, `bundled:${bundledId}`);
  const food = dbFood(bundledId);
  const numbers = food ? numbersKey(per100gFromBundled(food)) : "unknown";
  return uuidV5(BUNDLED_NAMESPACE, `bundled:${userId}:${bundledId}:${numbers}`);
}

export type AdoptedBundledFood = {
  foodRefId: string; per100g: Partial<Record<NutrientCode, number>>;
};

/** What the local index (and a server `user_foods` read) can say about an adopted food. */
export type AdoptedSnapshot = { name: string; per100g: Partial<Record<NutrientCode, number | null>> };
type AdoptedIndex = Record<string, AdoptedSnapshot>;

/**
 * food_ref_id → the bundled name and numbers, so an ingredient reopened in the sheet reads as the
 * food it holds rather than "Saved food" and the strip keeps its calories before any sync. A
 * client-only convenience in the `meta` store, exactly like the favorites name index: a missing
 * entry renders the placeholder and costs nothing.
 */
export async function rememberAdopted(
  h: AccountHandle, foodRefId: string, snapshot: AdoptedSnapshot,
): Promise<void> {
  try {
    const db = await openAccountDb(h);
    // One readwrite transaction for the read and the write: two adoptions racing (each awaiting
    // its own RPC) would otherwise both read the old index and the second write would drop the
    // first snapshot. Mirrors appendOp in lib/sync/idb.ts.
    const tx = db.transaction(META_STORE, "readwrite");
    const store = tx.objectStore(META_STORE);
    const index = ((await store.get(ADOPTED_INDEX_KEY)) as AdoptedIndex | undefined) ?? {};
    assertCurrent(h);
    await store.put({ ...index, [foodRefId]: snapshot }, ADOPTED_INDEX_KEY);
    await tx.done;
  } catch (e) {
    // No IndexedDB (a headless run) — the server row is the real store. An account switch is not
    // that case: the caller stops.
    rethrowAccountChanged(e);
  }
}

export async function adoptedSnapshot(
  foodRefId: string, h: AccountHandle = accountHandle(),
): Promise<AdoptedSnapshot | undefined> {
  try {
    const db = await openAccountDb(h);
    const index = ((await db.get(META_STORE, ADOPTED_INDEX_KEY)) as AdoptedIndex | undefined) ?? {};
    assertCurrent(h);
    return index[foodRefId];
  } catch (e) {
    rethrowAccountChanged(e);
    return undefined;
  }
}

/** What an adopted `user_foods` row holds: its deterministic id, its name and its numbers. */
export type AdoptableFood = {
  id: string; name: string; per100g: Partial<Record<NutrientCode, number>>;
};

/** The `user_foods` row both write paths carry: the direct upsert and the op-log payload. */
function userFoodRow(userId: string, food: AdoptableFood): Record<string, unknown> {
  return { id: food.id, user_id: userId, kind: "custom", name: food.name, per_100g: food.per100g };
}

/**
 * Mirror the row and queue its op at the rev the direct upsert landed, so the op applies on the
 * server instead of coming straight back as a conflict the outbox has to rebase. A failure here
 * is a failure of the adoption: it propagates to `adoptBundledFood`, which answers null and the
 * sheet shows its inline line — a broken normalized write is never hidden behind a "landed" add.
 */
async function queueUserFoodOp(
  h: AccountHandle, row: Record<string, unknown>, rev: number,
): Promise<void> {
  const now = new Date().toISOString();
  await putRow(h, "user_foods", String(row.id), { ...row, rev, deleted_at: null, updated_at: now });
  await enqueue(h, {
    op_id: crypto.randomUUID(), entity: "user_foods", entity_id: String(row.id),
    kind: "update", base_rev: rev, payload: row, client_ts: now,
  });
}

/** The row, mirrored and queued at the rev the upsert returned — null when the write was refused. */
async function upsertUserFood(
  h: AccountHandle, supabase: SupabaseClient, food: AdoptableFood,
): Promise<number | null> {
  // The owner goes INTO the row (Phase 9 §0.5a): RLS refuses it under another account's session.
  const row = userFoodRow(h.userId, food);
  // `.select("rev")` is what makes the queued op's base_rev real: a straight upsert returns no
  // row at all, and a guess of 1 is wrong the second time this food is adopted.
  const written = await withAccount(h, () => supabase.from("user_foods")
    .upsert(row, { onConflict: "id" }).select("rev").single());
  if (written.error) return null;
  const rev = (written.data as { rev?: unknown } | null)?.rev;
  if (typeof rev !== "number") return null;
  await queueUserFoodOp(h, row, rev);
  return rev;
}

async function foodRefFor(
  h: AccountHandle, supabase: SupabaseClient, id: string,
): Promise<string | null> {
  const ref = await withAccount(h, (userId) => supabase.rpc("get_or_create_food_ref", {
    p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: id,
  }));
  return ref.error || typeof ref.data !== "string" ? null : ref.data;
}

/**
 * Adopt any food the phone holds numbers for — a bundled food, or an account food's per-unit
 * numbers — as one deterministic `user_foods` row, and return its food ref. The same two writes
 * and the same failure rule as a bundled adoption: null when the user is signed out, offline, or
 * either write is refused.
 */
export async function adoptUserFood(
  food: AdoptableFood, opts: { client?: SupabaseClient; account?: AccountHandle } = {},
): Promise<string | null> {
  const h = opts.account ?? accountHandle();
  try {
    const supabase = opts.client ?? browserClient();
    if (await upsertUserFood(h, supabase, food) === null) return null;
    const foodRefId = await foodRefFor(h, supabase, food.id);
    if (!foodRefId) return null;
    await rememberAdopted(h, foodRefId, { name: food.name, per100g: food.per100g });
    return foodRefId;
  } catch (e) {
    // The account changed while this ran: the caller must stop, not read it as "no ref".
    rethrowAccountChanged(e);
    // Refused or offline: nothing more is written, and the caller shows its own line.
    return null;
  }
}

/**
 * Adopt a bundled food and return the food ref a recipe item can point at. Null when the food is
 * unknown, the user is signed out, or either write is refused — the caller shows its own line rather
 * than reading a blocked add as if it had landed.
 */
export async function adoptBundledFood(
  bundledId: string, opts: { client?: SupabaseClient; account?: AccountHandle } = {},
): Promise<AdoptedBundledFood | null> {
  const food = dbFood(bundledId);
  if (!food) return null;
  const per100g = per100gFromBundled(food);
  const h = opts.account ?? accountHandle();
  const id = await bundledFoodUserId(bundledId, h.userId);
  try {
    const foodRefId = await adoptUserFood({ id, name: food.name, per100g }, { ...opts, account: h });
    return foodRefId ? { foodRefId, per100g } : null;
  } catch {
    // The account changed while this ran (AccountChanged): nothing more is written, and the
    // sheet shows its inline line — this function's contract since T1.
    return null;
  }
}
