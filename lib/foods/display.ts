/**
 * How the Foods page states a food's energy (owner, 2026-10-04): per 100 g, the standard on
 * nutrition labels and apps, never per gram. "0 kcal / 1 g" read as zero for a food stored per
 * gram (every catalog food is), when it was 1.65 kcal a gram — 165 kcal / 100 g.
 *
 * A food measured in grams is stated per 100 g and one measured in millilitres per 100 ml (a volume
 * base from its entered per-ml figures, never a gram claim). Every other unit converts by the one
 * account-food weight (lib/foods/unit-grams.ts: a curated starter's weight, then the food list's
 * household portion); a unit with no known weight (a cup of a home recipe) keeps its honest
 * per-serving figure. A food with no
 * nutrition at all says so rather than printing a misleading zero; a food whose stored macros are
 * all zero (water, diet soda) is "0 kcal / 100 g", not missing (2026-10-04 audit, MINOR 11).
 *
 * Pure. No I/O.
 */
import { UNIT_LABELS, type Food } from "@/lib/foods";
import { macroKcal } from "@/lib/scaling";
import { accountUnitGrams } from "@/lib/foods/unit-grams";

/**
 * Grams (or millilitres) in one of the food's units when that weight is exact, or null. A curated
 * starter's own portion comes first: it is the weight the phone multiplied the per-gram row by
 * (lib/store.ts foodsFromSyncRows), so dividing by it gives back the stored per-100 g figure. A
 * household portion guessed from the food list could differ from that and print a wrong number.
 */
export function unitGrams(food: Pick<Food, "name" | "unit">): number | null {
  // The Foods page states g and ml foods per 100 of their own unit (100 ml is a volume base).
  if (food.unit === "g" || food.unit === "ml") return 1;
  // Every other unit: the one account-food weight (lib/foods/unit-grams.ts), the same one the
  // logger and the per_100g writer use, so the page, the log and the server row agree.
  return accountUnitGrams(food);
}

/** The base the Foods page states this food against: 100 g, 100 ml, or one serving. */
export function per100Base(food: Pick<Food, "name" | "unit">): { factor: number; label: string } {
  const grams = unitGrams(food);
  if (grams === null || grams <= 0) return { factor: 1, label: `1 ${UNIT_LABELS[food.unit]}` };
  return { factor: 100 / grams, label: food.unit === "ml" ? "100 ml" : "100 g" };
}

export const NO_NUTRITION_LABEL = "No nutrition yet";

/** "165 kcal / 100 g", "0 kcal / 100 ml" for water, or "No nutrition yet" for a food with no
 *  macros recorded (lib/store.ts sets `nutritionUnknown`). */
export function kcalPer100Label(food: Pick<Food, "name" | "unit" | "perUnit" | "nutritionUnknown">): string {
  const perUnit = macroKcal(food.perUnit);
  // The flag only explains a zero: macros entered since the last sync still print.
  if (!Number.isFinite(perUnit) || perUnit < 0 || (perUnit === 0 && food.nutritionUnknown)) return NO_NUTRITION_LABEL;
  const { factor, label } = per100Base(food);
  return `${Math.round(perUnit * factor)} kcal / ${label}`;
}
