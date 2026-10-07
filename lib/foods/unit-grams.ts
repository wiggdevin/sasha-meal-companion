/**
 * The one answer to "how many grams is one of this account food's units?" (Grok round 5).
 *
 * The curated starter's own portion comes first: it is the weight the starter's per-unit macros were
 * built from (lib/foods/starter.ts `starterFood`) and the weight the phone multiplies a synced row by
 * (lib/store.ts `foodsFromSyncRows`), so the curated 245 g yogurt cup or 118 g banana wins over the
 * food list's own first household row (81 g for "1 extra small" banana). Then the food list's
 * household portion, the dimensional units and the liquid densities (lib/units.ts `gramsPerUnit`).
 * Null when no real weight is known.
 *
 * Every reader that means this weight uses it: `mineAsDb` (the logger), `per100gFor` (the
 * `user_foods.per_100g` writer), the Foods page base (lib/foods/display.ts), `gramsOf`
 * (lib/meals/parts.ts), meal-swap sizing and the starter attestation. Pure. No I/O.
 */
import type { Food } from "@/lib/foods";
import { starterPortionGrams } from "@/lib/foods/starter";
import { gramsPerUnit } from "@/lib/units";

/** The first candidate that is a real weight (finite, above zero); a 0 or NaN never hides the next. */
export function firstRealWeight(...candidates: (number | null | undefined)[]): number | null {
  for (const grams of candidates) {
    if (typeof grams === "number" && Number.isFinite(grams) && grams > 0) return grams;
  }
  return null;
}

/** Grams in one of the food's units: the starter's curated weight, then the food list and units. */
export function accountUnitGrams(food: Pick<Food, "name" | "unit">): number | null {
  return firstRealWeight(starterPortionGrams(food.name, food.unit), gramsPerUnit(food.name, food.unit));
}

/**
 * The weight the per_100g writer used before this resolver: the food list first, then the starter,
 * with every millilitre counted as 1 g (lib/units.ts before densities). Kept only so the starter
 * attestation still recognises rows it wrote; never used to write. A 0 or NaN reads as no weight.
 */
export function legacyWriterUnitGrams(food: Pick<Food, "name" | "unit">): number | null {
  const list = food.unit === "ml" ? 1 : gramsPerUnit(food.name, food.unit);
  return firstRealWeight(list, starterPortionGrams(food.name, food.unit));
}
