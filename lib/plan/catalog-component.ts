// lib/plan/catalog-component.ts
/**
 * A catalog row, as a line on a slot card — Phase C of
 * docs/plans/2026-09-14-slot-item-editing.md.
 *
 * Phase B split the latte so there was a milk line to tap. Driving it showed what was still
 * missing: "Something else" offered only account foods, which are proteins, carbs and fats, so
 * there was no whole milk to pick. The 13,694-food catalog has it; this is the conversion.
 *
 * The catalog stores per-100 g amounts under the codes in `catalog_nutrients`. Energy is measured
 * (`energy_kcal`) where USDA has it and Atwater-calculated (`energy_kcal_calc`) where it does not;
 * a row with neither falls back to the macros, the same order lib/food-db.ts already uses — but
 * only when all three macros are known. A null amount is unknown, never zero.
 */
import { macroKcal } from "@/lib/scaling";
import type { FoodComponent } from "@/lib/types";

/** Per-100 g amounts keyed by `catalog_nutrients.code`. A missing or null value means "unknown". */
export type Per100g = Record<string, number | null | undefined>;

const PROTEIN = "protein";
const CARBS = "carbohydrate";
const FAT = "fat_total";
const ENERGY = "energy_kcal";
const ENERGY_CALC = "energy_kcal_calc";

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A finite, non-negative amount, or null for unknown. A negative amount is a broken row, not data. */
function known(per100g: Per100g, code: string): number | null {
  const value = per100g[code];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The row's own energy, one rule: the measured value if it is finite and >= 0, else the calculated
 * one under the same test, else unknown (the caller then needs all three macros for Atwater). A
 * negative or NaN field is missing for that field only, so it never vetoes a good sibling. A
 * stored 0 is a measurement like any other value (zero-calorie noodles, diet drinks): rewriting
 * it from the macros would invent calories.
 */
function energyOf(per100g: Per100g): number | null {
  return known(per100g, ENERGY) ?? known(per100g, ENERGY_CALC);
}

export type CatalogNutritionGap = "kcal" | "protein" | "carbs" | "fat";

/**
 * Which of the four card numbers this row cannot state. Energy is known when the row measures or
 * calculates it, or when all three macros are known (Atwater). An empty list means complete.
 */
export function catalogNutritionGaps(per100g: Per100g): CatalogNutritionGap[] {
  const gaps: CatalogNutritionGap[] = [];
  const protein = known(per100g, PROTEIN);
  const carbs = known(per100g, CARBS);
  const fat = known(per100g, FAT);
  const energy = energyOf(per100g);
  if (energy === null && (protein === null || carbs === null || fat === null)) gaps.push("kcal");
  if (protein === null) gaps.push("protein");
  if (carbs === null) gaps.push("carbs");
  if (fat === null) gaps.push("fat");
  return gaps;
}

function build(name: string, per100g: Per100g, grams: number): FoodComponent {
  const scale = Number.isFinite(grams) && grams > 0 ? grams / 100 : 0;
  const protein = round1((known(per100g, PROTEIN) ?? 0) * scale);
  const carbs = round1((known(per100g, CARBS) ?? 0) * scale);
  const fat = round1((known(per100g, FAT) ?? 0) * scale);
  const energy = energyOf(per100g);
  const kcal = energy !== null ? Math.round(energy * scale) : Math.round(macroKcal({ protein, carbs, fat }));
  return {
    name,
    qty: scale > 0 ? grams : 0,
    unit: "g",
    // A catalog pick is not one of the three authored roles, and claiming one would let the
    // scaler treat it as protein and refuse to resize it.
    role: "free",
    macros: { kcal, protein, carbs, fat },
  };
}

/**
 * The plan line for a catalog row, or null when the row cannot state all four card numbers
 * (`catalogNutritionGaps`). A plan line has no way to say "unknown", so an incomplete row is
 * refused rather than shown and summed as a measured zero (audit #20; the recipe paths keep the
 * same null-is-not-zero rule, lib/recipes/nutrients.ts). Every lib/ writer uses this.
 */
export function completeComponentFromCatalog(
  name: string, per100g: Per100g, grams: number,
): FoodComponent | null {
  return catalogNutritionGaps(per100g).length === 0 ? build(name, per100g, grams) : null;
}

/**
 * The lenient form some UI previews and the UI's own slot editor still call (components/ is the UI
 * lane's): an unknown or negative nutrient reads as zero so the card never shows NaN. It cannot say
 * "unknown", so code that writes a plan or log line must call `completeComponentFromCatalog`, and
 * a caller can ask `catalogNutritionGaps` first.
 */
export function componentFromCatalog(
  name: string, per100g: Per100g, grams: number
): FoodComponent {
  return build(name, per100g, grams);
}
