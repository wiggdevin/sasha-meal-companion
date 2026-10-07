/**
 * The canonical nutrient vocabulary. Phase 1–2 contracts §2 freezes both the codes and their
 * units; catalog_nutrients on the database side carries the same pairs, and the import worker
 * (Lane F) agrees with this file. Pure data, no imports.
 */

export const NUTRIENT_CODES = [
  "energy_kcal", "energy_kcal_calc", "protein", "carbohydrate", "fat_total", "fiber_total",
  "sugars_total", "sodium", "potassium", "calcium", "iron", "magnesium", "zinc", "vitamin_c",
  "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae", "saturated_fat", "cholesterol",
] as const;

export type NutrientCode = (typeof NUTRIENT_CODES)[number];

/** Units are kcal, g, mg and µg — contracts §2. The snapshot passes the DB unit through; this
 *  table is the offline fallback when a cached catalog row carries no unit of its own. */
export const NUTRIENT_UNITS: Record<NutrientCode, string> = {
  energy_kcal: "kcal", energy_kcal_calc: "kcal", protein: "g", carbohydrate: "g",
  fat_total: "g", fiber_total: "g", sugars_total: "g", saturated_fat: "g",
  sodium: "mg", potassium: "mg", calcium: "mg", iron: "mg", magnesium: "mg", zinc: "mg",
  vitamin_c: "mg", cholesterol: "mg",
  vitamin_d: "µg", vitamin_b12: "µg", folate_dfe: "µg", vitamin_a_rae: "µg",
};

export const MACRO_CODES = {
  kcal: "energy_kcal", protein: "protein", carbs: "carbohydrate",
  fat: "fat_total", fiber: "fiber_total",
} as const;

/** The twelve codes seeded in 20260918090300 and counted by the Today coverage pill. */
export const TRACKED_MICROS: readonly NutrientCode[] = [
  "fiber_total", "iron", "calcium", "potassium", "magnesium", "zinc", "vitamin_c",
  "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae", "sodium",
];

/** targets.md, not the DRI: 20–25 g/day soluble-dominant. The band wins on their screen. */
export const FIBER_BAND_G = { min: 20, max: 25 } as const;

const CODE_SET: ReadonlySet<string> = new Set(NUTRIENT_CODES);

export function isNutrientCode(value: string): value is NutrientCode {
  return CODE_SET.has(value);
}
