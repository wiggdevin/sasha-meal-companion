/**
 * Recipe nutrient maths — Phase 3 spec, "Engines and logic". The client half of the SQL in
 * 20260919090300_phase3_sync_entities.sql (energy: 20261230090400_recipe_energy_rule): same sums,
 * same null rule, same coverage, so the sheet shows the numbers the server is about to store. The
 * server's value still wins on sync.
 *
 * `null` is "not measured" and `0` is "measured zero" (architecture §3.3). Summing a null as a
 * zero would let a recipe with one unmeasured item read as a complete one, which is the exact
 * failure `daily_totals`' coverage column exists to prevent.
 *
 * Pure. No I/O.
 */
import { MACRO_CODES, type NutrientCode } from "@/lib/nutrients/codes";
import { itemKcal } from "@/lib/nutrients/energy";

/** The two energy fields the one energy rule chooses between (lib/nutrients/energy.ts). */
const ENERGY_REPORTED = "energy_kcal";
const ENERGY_CALCULATED = "energy_kcal_calc";

export type RecipeItemInput = {
  seq: number; foodRefId: string; qty: number; unit: string;
  grams: number; state: "raw" | "cooked"; foodRevisionId?: number | null;
  /**
   * Client-only per-100 g snapshot — the bundled numbers of an adopted ingredient, kept in local
   * item state so the strip has something to read before the food ref has a cached revision. It
   * never goes on the wire: lib/recipes-client.ts `wireItems` builds its keys one by one.
   */
  per100g?: Partial<Record<NutrientCode, number | null>> | null;
};

/** food_ref_id → the per-100 g map of the revision (or user food) that ref resolves to. */
export type Per100gByRef = Record<string, Record<NutrientCode, number | null>>;

/** The five macros the coverage scalar is the minimum over. */
export const TRACKED_MACROS: readonly NutrientCode[] = [
  MACRO_CODES.kcal, MACRO_CODES.protein, MACRO_CODES.carbs, MACRO_CODES.fat, MACRO_CODES.fiber,
];

/** Four decimals, matching Postgres `round(numeric, 4)` in compute_item_snapshot. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function recipeInputGrams(items: RecipeItemInput[]): number {
  return round4(items.reduce((sum, item) => sum + item.grams, 0));
}

/**
 * Grams in one serving. `yieldGrams` is the weight of the finished dish when the user weighed it;
 * without it the input weight stands in, which over-reads a serving of anything that lost water.
 */
export function servingGrams(totalGrams: number, servings: number, yieldGrams?: number): number {
  if (!(servings > 0)) throw new RangeError("servings must be greater than 0");
  const finished = yieldGrams === undefined || yieldGrams === null ? totalGrams : yieldGrams;
  return round4(finished / servings);
}

/**
 * A recipe's per-serving numbers and how much of them is real. `coverage` is the stored scalar
 * (the minimum, over the five tracked macros, of measured items ÷ all items — the SQL twin's
 * `nutrients_per_serving.coverage`). `nutritionComplete` is true only at coverage 1: below it the
 * per-serving figures are the sum of the items that WERE measured, so a kcal shown or logged from
 * them is a partial count, never the full serving (calculation audit 2026-10-05, #21).
 */
export type RecipeNutrition = {
  perServing: Record<string, number | null>; coverage: number; nutritionComplete: boolean;
};

/** The one completeness rule, shared by the client sum and every reader of a stored row. */
export function isNutritionComplete(coverage: number): boolean {
  return Number.isFinite(coverage) && coverage >= 1;
}

/**
 * Coverage and completeness read from a stored `nutrients_per_serving` object (server row or the
 * phone's provisional copy). A missing or malformed coverage reads as 0 — unknown is never
 * complete.
 */
export function recipeNutritionStatus(
  stored: Readonly<Record<string, unknown>> | null | undefined,
): { coverage: number; nutritionComplete: boolean } {
  const raw = stored?.coverage;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  const coverage = Number.isFinite(value) && value >= 0 ? Math.min(1, round4(value)) : 0;
  return { coverage, nutritionComplete: isNutritionComplete(coverage) };
}

export function computeRecipeNutrients(
  items: RecipeItemInput[], per100g: Per100gByRef, servings: number, yieldGrams?: number,
): RecipeNutrition {
  if (!(servings > 0)) throw new RangeError("servings must be greater than 0");
  // A serving is one servings-th of the whole recipe whatever the finished weight is; the yield
  // only converts grams into a serving fraction (servingGrams). Taken so the signature matches
  // the spec's Engines section.
  void yieldGrams;

  const totals = new Map<string, number>();
  const measured = new Map<string, number>();
  const add = (code: string, value: number | null | undefined, grams: number) => {
    if (!totals.has(code)) totals.set(code, 0);
    if (value === null || value === undefined) return;
    totals.set(code, (totals.get(code) ?? 0) + (value * grams) / 100);
    measured.set(code, (measured.get(code) ?? 0) + 1);
  };
  for (const item of items) {
    const values = per100g[item.foodRefId] ?? {};
    for (const [code, value] of Object.entries(values)) {
      if (code === ENERGY_REPORTED || code === ENERGY_CALCULATED) continue;
      add(code, value, item.grams);
    }
    // Energy, one rule per ingredient BEFORE the sum (W004, audit A008): reported, else calculated,
    // else unknown. The recipe stores the selected sum as `energy_kcal` and counts a calculated-only
    // ingredient toward its coverage; no separate `energy_kcal_calc` sum is kept.
    if (ENERGY_REPORTED in values || ENERGY_CALCULATED in values) {
      add(ENERGY_REPORTED, itemKcal({
        [ENERGY_REPORTED]: { amount: values[ENERGY_REPORTED as NutrientCode] },
        [ENERGY_CALCULATED]: { amount: values[ENERGY_CALCULATED as NutrientCode] },
      }), item.grams);
    }
  }

  const perServing: Record<string, number | null> = {};
  for (const [code, total] of totals) {
    perServing[code] = (measured.get(code) ?? 0) === 0 ? null : round4(total / servings);
  }

  const coverage = items.length === 0
    ? 0
    : Math.min(...TRACKED_MACROS.map((code) => (measured.get(code) ?? 0) / items.length));
  const rounded = round4(coverage);
  return { perServing, coverage: rounded, nutritionComplete: isNutritionComplete(rounded) };
}
