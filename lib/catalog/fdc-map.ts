/**
 * FDC Branded → RevisionDraft. Branded rows already carry per-100 g values, so the only work is
 * the nutrient-id table, a unit conversion into our canonical units, and the same three rules
 * off-map.ts follows: null is not zero, all four absent is a reject, ingredients are scanned.
 *
 * The RevisionDraft type and every shared helper come from off-map.ts — one declaration, so the
 * two mappers can never drift apart.
 */
import type { FdcBrandedFood, FdcNutrient } from "@/lib/catalog/fdc";
import {
  atwaterKcal, deriveCategory, draftPolicyCategories, emptyPer100g, energyFlags, ingredientRows,
  round4, type RevisionDraft,
} from "@/lib/catalog/off-map";
import { NUTRIENT_UNITS, type NutrientCode } from "@/lib/nutrients/codes";

export type { RevisionDraft } from "@/lib/catalog/off-map";

/** FDC nutrient ids, FoodData Central's own numbering. 1190 (DFE) wins over 1177 (total). */
export const FDC_NUTRIENT_CODES: Record<number, NutrientCode> = {
  1008: "energy_kcal", 1003: "protein", 1005: "carbohydrate", 1004: "fat_total",
  1079: "fiber_total", 2000: "sugars_total", 1063: "sugars_total", 1093: "sodium",
  1092: "potassium", 1087: "calcium", 1089: "iron", 1090: "magnesium", 1095: "zinc",
  1162: "vitamin_c", 1114: "vitamin_d", 1178: "vitamin_b12", 1177: "folate_dfe",
  1190: "folate_dfe", 1106: "vitamin_a_rae", 1258: "saturated_fat", 1253: "cholesterol",
};

const SCALE: Record<string, number> = { G: 1, MG: 1e-3, UG: 1e-6, KCAL: 1 };
const TARGET: Record<string, number> = { kcal: 1, g: 1, mg: 1e-3, "µg": 1e-6 };

/** Value in FDC's unit → the unit lib/nutrients/codes.ts pins for that code. `IU` is refused. */
export function convertAmount(value: number, unitName: string, code: NutrientCode): number | null {
  const from = SCALE[unitName.toUpperCase()];
  const to = TARGET[NUTRIENT_UNITS[code]];
  if (from === undefined || to === undefined) return null;
  return round4((value * from) / to);
}

function readNutrients(list: FdcNutrient[]): Record<NutrientCode, number | null> {
  const per100g = emptyPer100g();
  for (const n of list) {
    const code = FDC_NUTRIENT_CODES[n.nutrientId];
    if (!code || typeof n.value !== "number" || !Number.isFinite(n.value)) continue;
    if (code === "folate_dfe" && n.nutrientId === 1177 && per100g.folate_dfe !== null) continue;
    const amount = convertAmount(n.value, n.unitName ?? "G", code);
    if (amount !== null) per100g[code] = amount;
  }
  return per100g;
}

export function fdcBrandedToRevision(
  f: FdcBrandedFood,
  fetchedAt: string
): RevisionDraft | { reject: string } {
  const per100g = readNutrients(f.foodNutrients ?? []);
  if (
    per100g.energy_kcal === null && per100g.protein === null &&
    per100g.carbohydrate === null && per100g.fat_total === null
  ) {
    return { reject: "no_nutrition" };
  }
  const flags: string[] = [];
  const atwater = atwaterKcal(per100g);
  per100g.energy_kcal_calc = atwater.kcal;
  if (atwater.complete && per100g.fiber_total === null) flags.push("carb_basis_total");
  flags.push(...energyFlags(per100g.energy_kcal, atwater.kcal));

  const ingredientsText = f.ingredients?.trim() || null;
  const { rows, flags: rowFlags } = ingredientRows(ingredientsText, []);

  const grams =
    typeof f.servingSize === "number" && f.servingSize > 0 &&
    (f.servingSizeUnit ?? "").toLowerCase().startsWith("g")
      ? round4(f.servingSize)
      : null;

  const description = f.description.trim() || "Scanned product";
  const category = deriveCategory(f.brandedFoodCategory);
  return {
    description,
    brand: f.brandName?.trim() || f.brandOwner?.trim() || null,
    qualityClass: "label",
    per100g,
    portions: grams === null
      ? []
      : [{ description: f.householdServingFullText?.trim() || `${grams} g`, gramWeight: grams }],
    ingredients: rows,
    ingredientsText,
    qualityFlags: [...new Set([...flags, ...rowFlags])],
    category,
    // The DERIVED category, like off-map: it is what lands in `category` and what a later
    // annotation pass would read back, so the two runs cannot disagree.
    policyCategories: draftPolicyCategories(description, category),
    sourceId: "",
    publishedAt: f.publishedDate?.trim() || fetchedAt,
  };
}
