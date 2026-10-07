import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { systemOne } from "@/lib/ai/typesafe";
import {
  adviseMealComponentRole,
  type MealComponentRoleAdvice,
  type RolePort,
  type StoredMealRole,
} from "@/lib/coach/role-advice";

/**
 * Role advice for the two non-coach add paths (task t2c): Foods › add-food and the capture draft.
 * Same function, same rules and the same `meal-component-role` purpose as the coach's
 * `add_to_eats` / `add_to_avoid` (lib/server/coach-role-advice.ts). It only PROPOSES: every advice
 * carries `requiresConfirmation: true`, nothing here writes a role, and the user's yes goes through
 * `POST /api/foods/role/confirm`. A food whose stored role is already set gets no advice. Every
 * failure — a read, Jev down, the daily cap, a deadline — answers "no advice" and never fails the
 * request it rides on.
 */

/** At most this many foods are advised per request: each is one Jev call. */
export const MAX_ROLE_ADVICE_FOODS = 6;
const DEFAULT_DEADLINE_MS = 2_500;

export type FoodRoleAdviceDeps = {
  systemOne?: RolePort;
  deadlineMs?: number;
};

type Subject = {
  foodRefId: string; name: string; prepState: string | null;
  proteinPer100g: number | null; carbsPer100g: number | null; fatPer100g: number | null;
};
type PrefRow = { food_ref_id: string; status: string | null; role: string | null };
type RefRow = {
  id: string; catalog_food_id: number | null;
  user_foods: { name: string | null; per_100g: Record<string, unknown> | null } | null;
};
type RevisionRow = {
  catalog_food_id: number; description: string; prep_state: string | null;
  catalog_food_nutrients: { nutrient_code: string; amount_per_100g: number | null }[] | null;
};

const isRole = (value: unknown): value is StoredMealRole =>
  value === "protein" || value === "carb" || value === "fat";

function amount(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? null : n;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].slice(0, MAX_ROLE_ADVICE_FOODS);
}

async function readPrefs(
  client: SupabaseClient, userId: string, ids: string[],
): Promise<Map<string, PrefRow>> {
  const rows = await client.from("user_food_prefs").select("food_ref_id,status,role")
    .eq("user_id", userId).in("food_ref_id", ids);
  if (rows.error) throw rows.error;
  return new Map(((rows.data ?? []) as PrefRow[]).map((row) => [String(row.food_ref_id), row]));
}

/** Name, prep state and the three macros per 100 g, read on the server — never from the client. */
async function readSubjects(client: SupabaseClient, ids: string[]): Promise<Subject[]> {
  if (ids.length === 0) return [];
  const refs = await client.from("food_refs")
    .select("id, catalog_food_id, user_food_id, user_foods(name, per_100g)").in("id", ids);
  if (refs.error) throw refs.error;
  const refRows = (refs.data ?? []) as unknown as RefRow[];
  const catalogIds = [...new Set(refRows.map((ref) => ref.catalog_food_id)
    .filter((id): id is number => id !== null && id !== undefined))];
  const revisions = new Map<number, RevisionRow>();
  if (catalogIds.length > 0) {
    const revs = await client.from("catalog_food_revisions")
      .select("catalog_food_id, description, prep_state, catalog_food_nutrients(nutrient_code, amount_per_100g)")
      .eq("is_active", true).in("catalog_food_id", catalogIds);
    if (revs.error) throw revs.error;
    for (const rev of (revs.data ?? []) as unknown as RevisionRow[]) {
      revisions.set(rev.catalog_food_id, rev);
    }
  }
  const subjects: Subject[] = [];
  for (const ref of refRows) {
    const own = ref.user_foods;
    if (own?.name) {
      const per = own.per_100g ?? {};
      subjects.push({ foodRefId: String(ref.id), name: own.name, prepState: null,
        proteinPer100g: amount(per.protein), carbsPer100g: amount(per.carbohydrate),
        fatPer100g: amount(per.fat_total) });
      continue;
    }
    const rev = ref.catalog_food_id === null ? undefined : revisions.get(ref.catalog_food_id);
    if (!rev) continue;
    const nutrient = (code: string) => amount(rev.catalog_food_nutrients
      ?.find((row) => row.nutrient_code === code)?.amount_per_100g);
    subjects.push({ foodRefId: String(ref.id), name: rev.description, prepState: rev.prep_state,
      proteinPer100g: nutrient("protein"), carbsPer100g: nutrient("carbohydrate"),
      fatPer100g: nutrient("fat_total") });
  }
  return subjects;
}

async function adviseSubjects(
  userId: string, subjects: Subject[], deps: FoodRoleAdviceDeps,
): Promise<Map<string, MealComponentRoleAdvice>> {
  const port = deps.systemOne ?? systemOne;
  const answers = await Promise.all(subjects.map((subject) => adviseMealComponentRole({
    ...subject, description: null, storedRole: null,
  }, { userId, systemOne: port, deadlineMs: deps.deadlineMs ?? DEFAULT_DEADLINE_MS })
    .catch(() => null)));
  const out = new Map<string, MealComponentRoleAdvice>();
  for (const advice of answers) if (advice) out.set(advice.foodRefId, advice);
  return out;
}

function warn(where: string, error: unknown): void {
  console.warn(`[food-role-advice] ${where} failed; no advice`, {
    error: { name: error instanceof Error ? error.name : "UnknownError" },
  });
}

/**
 * Foods › add-food: advice for foods the account has just put on Eats or Avoid and that have no
 * stored role. A food with no membership row is skipped — the confirm route would refuse it.
 */
export async function adviseMemberFoodRoles(
  client: SupabaseClient, userId: string, foodRefIds: readonly string[],
  deps: FoodRoleAdviceDeps = {},
): Promise<Map<string, MealComponentRoleAdvice>> {
  const ids = uniqueIds(foodRefIds);
  if (ids.length === 0) return new Map();
  try {
    const prefs = await readPrefs(client, userId, ids);
    const candidates = ids.filter((id) => {
      const pref = prefs.get(id);
      return (pref?.status === "eats" || pref?.status === "avoid") && !isRole(pref.role);
    });
    return await adviseSubjects(userId, await readSubjects(client, candidates), deps);
  } catch (error) {
    warn("member advice", error);
    return new Map();
  }
}

/**
 * Capture draft: advice for grounded foods with no stored role on this account, whether or not
 * they are on a list yet (a draft item may become an Eats food). A stored role always wins.
 */
export async function adviseDraftFoodRoles(
  client: SupabaseClient, userId: string, foodRefIds: readonly (string | null)[],
  deps: FoodRoleAdviceDeps = {},
): Promise<Map<string, MealComponentRoleAdvice>> {
  const ids = uniqueIds(foodRefIds.filter((id): id is string => typeof id === "string"));
  if (ids.length === 0) return new Map();
  try {
    const prefs = await readPrefs(client, userId, ids);
    const candidates = ids.filter((id) => !isRole(prefs.get(id)?.role));
    return await adviseSubjects(userId, await readSubjects(client, candidates), deps);
  } catch (error) {
    warn("draft advice", error);
    return new Map();
  }
}
