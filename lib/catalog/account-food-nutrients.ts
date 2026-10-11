/**
 * A catalog revision → the `user_foods.per_100g` an account food stores for it (W004, audit
 * 2026-10-10 A154). Only the codes the revision actually carries are written: an unmeasured
 * nutrient stays absent, because every reader (the coach's exact-name grounding, the plan line,
 * `compute_item_snapshot`, the day totals) reads a stored 0 as a measured zero. The catalog keeps
 * the Atwater figure under `energy_kcal_calc` for a food the source did not measure (FDC Foundation
 * without a 1008 row), so that code is copied too, under its own name, and the one energy rule
 * (lib/nutrients/energy.ts) selects it wherever the row is read.
 *
 * Pure. No I/O. Shared by components/add-food/catalog-food.ts and
 * scripts/catalog-food-energy-backfill.ts.
 */
import type { NutrientCode } from "@/lib/nutrients/codes";
import { itemKcal } from "@/lib/nutrients/energy";

/** The codes an account food copies from its catalog revision. */
export const ACCOUNT_FOOD_CODES = [
  "energy_kcal", "energy_kcal_calc", "protein", "carbohydrate", "fat_total",
] as const satisfies readonly NutrientCode[];

export type AccountFoodCode = (typeof ACCOUNT_FOOD_CODES)[number];
export type AccountFoodPer100g = Partial<Record<AccountFoodCode, number>>;

/** A catalog detail's map (`{ code: { amount } }`) or anything shaped like it. */
export type CatalogAmounts = Readonly<Record<string, { readonly amount?: unknown } | null | undefined>>;

/** A finite amount >= 0, or null: absent, null, NaN, negative and non-numbers are not measured. */
function measured(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The measured codes of one revision, per 100 g. Absent stays absent; a measured 0 stays 0. */
export function accountFoodPer100g(values: CatalogAmounts): AccountFoodPer100g {
  const out: AccountFoodPer100g = {};
  for (const code of ACCOUNT_FOOD_CODES) {
    const amount = measured(values[code]?.amount);
    if (amount !== null) out[code] = amount;
  }
  return out;
}

/** The food's energy per 100 g by the one energy rule: reported, else calculated, else null. */
export function accountFoodKcalPer100g(
  per100g: Readonly<Partial<Record<string, unknown>>>,
): number | null {
  return itemKcal({ energy_kcal: { amount: per100g.energy_kcal },
    energy_kcal_calc: { amount: per100g.energy_kcal_calc } });
}
