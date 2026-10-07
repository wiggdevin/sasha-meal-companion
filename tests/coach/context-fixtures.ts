import { expect } from "vitest";
import type { DayContext } from "@/lib/server/day-context";
import type { Macros } from "@/lib/types";

/** Shared doubles and seed rows for the coach context tests. */

/** Every fixture below carries a target revision; assert it so the `needs_profile`
 *  branch (targets/remaining null) cannot leak into an arithmetic assertion. */
export function withTargets(day: DayContext): DayContext & { targets: Macros; remaining: Macros } {
  expect(day.targets).not.toBeNull();
  expect(day.remaining).not.toBeNull();
  return day as DayContext & { targets: Macros; remaining: Macros };
}

/** A Supabase double: table name -> rows, with the chain shape the context reads use. */
export function db(tables: Record<string, unknown[]>) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    let after: string | null = null;
    let limit = 1000;
    let offset = 0;
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain, is: () => chain,
      gt: (column: string, value: string) => {
        if (table === "user_food_prefs" && column === "food_ref_id") after = value;
        return chain;
      },
      gte: () => chain, lt: () => chain, lte: () => chain, not: () => chain, or: () => chain,
      order: () => chain, limit: (value: number) => { limit = value; return chain; },
      range: (from: number, to: number) => { offset = from; limit = to - from + 1; return chain; },
      maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: table === "user_food_prefs"
          ? (tables[table] ?? []).filter((row) => !after ||
            (row as { food_ref_id: string }).food_ref_id > after)
            .slice(offset, offset + Math.min(limit, 1000))
          : tables[table] ?? [], error: null }).then(resolve),
    });
    return chain;
  };
  return { from: (t: string) => api(t), rpc: async () => ({ data: [], error: null }) } as never;
}

export const REF_CHICKEN = "3f1b1a2c-0000-4000-8000-0000000000c1";
export const REF_BANANA = "3f1b1a2c-0000-4000-8000-0000000000b1";

export const MONDAY = "2026-09-14";

/** One effective server revision — the sole authority for the day's numbers (design §5.5). */
export const REVISION_ROW = {
  id: "3f1b1a2c-0000-4000-8000-0000000000a1", user_id: "u1", effective_from: "2026-09-01", rev: 3,
  kcal_train: 2200, kcal_rest: 1800, authored_by: "user", mode: "grams",
  protein_g: 120, fat_g: 80, carb_g: 250,
  protein_pct: null, fat_pct: null, carb_pct: null,
  kcal_min: 1200, protein_g_min: 120, fat_g_min: 50, carb_g_min: 0,
  goal_rate_bp_week: 0, max_weekly_kcal_step: 150, notes: null, target_source: "derived",
  training_macros: { kcal: 2200, protein: 120, carbs: 250, fat: 80 },
  rest_macros: { kcal: 1800, protein: 120, carbs: 150, fat: 80 },
  pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null,
  input_weight_kg: 59.25, input_weight_source: "weigh-in", input_training_weekdays: [1, 3, 5],
  input_activity_level: "moderate", input_goal: "recomp", formula_name: "profile-energy-v1",
};

/** An account with no foods plans nothing by rotation; an explicit override is a user action
 *  and still materializes its slot (design §2.1). */
export const MEAL_1_OVERRIDE = {
  baseMealId: null, followPlan: false, title: "Chicken and rice",
  components: [{ name: "Chicken breast", qty: 6, unit: "oz", role: "protein",
    macros: { kcal: 280, protein: 52, carbs: 0, fat: 6 } }],
};

export function seeded(extra: Record<string, unknown[]> = {}) {
  return db({
    settings: [],
    target_profiles: [REVISION_ROW],
    // The tick lives in `plan_days.eaten_slots` now, not the retired legacy `days` table.
    plan_days: [{ day_type_override: null, floor_day: false, swaps: {}, slot_notes: {},
      item_overrides: { "meal-1": MEAL_1_OVERRIDE },
      eaten_slots: { "meal-1": { eaten_at: `${MONDAY}T12:00:00.000Z`,
        changed_at: `${MONDAY}T12:00:00.000Z` } } }],
    user_foods: [],
    log_entries: [{
      id: "3f1b1a2c-0000-4000-8000-0000000000e1",
      eaten_at: `${MONDAY}T15:00:00.000Z`, slot: "meal-2", note: null,
      log_items: [{ seq: 1, grams: 120, food_ref_id: REF_CHICKEN,
        snapshot: { energy_kcal: { amount: 198 }, protein: { amount: 37 },
          carbohydrate: { amount: 0 }, fat_total: { amount: 4 } } }],
    }],
    food_refs: [
      { id: REF_CHICKEN, catalog_food_id: 11, user_food_id: null, user_foods: null },
      { id: REF_BANANA, catalog_food_id: 12, user_food_id: null, user_foods: null },
    ],
    catalog_food_revisions: [
      { catalog_food_id: 11, description: "Chicken breast, roasted" },
      { catalog_food_id: 12, description: "Banana, raw" },
    ],
    user_food_prefs: [
      { food_ref_id: REF_CHICKEN, status: "eats" },
      { food_ref_id: REF_BANANA, status: "avoid" },
    ],
    recipes: [],
    ...extra,
  });
}
