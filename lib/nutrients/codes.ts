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

/** What a person reads for each code: the codes themselves never reach the screen. */
export const NUTRIENT_LABELS: Record<NutrientCode, string> = {
  energy_kcal: "Calories", energy_kcal_calc: "Calories", protein: "Protein",
  carbohydrate: "Carbohydrates", fat_total: "Total fat", fiber_total: "Fibre",
  sugars_total: "Sugars", sodium: "Sodium", potassium: "Potassium", calcium: "Calcium",
  iron: "Iron", magnesium: "Magnesium", zinc: "Zinc", vitamin_c: "Vitamin C",
  vitamin_d: "Vitamin D", vitamin_b12: "Vitamin B12", folate_dfe: "Folate",
  vitamin_a_rae: "Vitamin A", saturated_fat: "Saturated fat", cholesterol: "Cholesterol",
};

/** A code's label, or the code made readable when a newer source sends one this file lacks. */
export function nutrientLabel(code: string): string {
  if (isNutrientCode(code)) return NUTRIENT_LABELS[code];
  const words = code.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The codes to show, in order. Calculated energy is a second "Calories" row, so it shows only when
 * there is no reported energy with a value (the energy rule, `lib/nutrients/energy.ts`); a reported
 * row with no value then hides instead, so one Calories row remains.
 */
export function visibleNutrientCodes<T extends string>(
  codes: readonly T[], hasValue: (code: T) => boolean = () => true,
): T[] {
  const reported = codes.find((code) => code === "energy_kcal");
  const calc = codes.find((code) => code === "energy_kcal_calc");
  if (reported === undefined || calc === undefined) return [...codes];
  const drop = hasValue(reported) || !hasValue(calc) ? calc : reported;
  return codes.filter((code) => code !== drop);
}

/** targets.md, not the DRI: 20–25 g/day soluble-dominant. The band wins on their screen. */
export const FIBER_BAND_G = { min: 20, max: 25 } as const;

const CODE_SET: ReadonlySet<string> = new Set(NUTRIENT_CODES);

export function isNutrientCode(value: string): value is NutrientCode {
  return CODE_SET.has(value);
}
