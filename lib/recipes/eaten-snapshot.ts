import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { FoodComponent, Macros } from "@/lib/types";

const macroKeys = ["kcal", "protein", "carbs", "fat"] as const;

/** History uses the accepted evidence, scaled by what was actually eaten. Planning bounds do not apply. */
export function eatenRecipeSnapshot(selection: AcceptedRecipeSelection, actualServings: number): FoodComponent {
  if (!Number.isFinite(actualServings) || actualServings <= 0 || actualServings > 20
    || !Number.isFinite(selection.servingFraction) || selection.servingFraction <= 0) {
    throw new RangeError("Enter a positive amount up to 20 servings.");
  }
  const ratio = actualServings / selection.servingFraction;
  const macros = {} as Macros;
  for (const key of macroKeys) {
    const evidence = selection.nutritionSnapshot[key];
    if (!evidence || evidence.status === "unknown" || evidence.value === null
      || !Number.isFinite(evidence.value) || evidence.value < 0) {
      throw new Error("This accepted portion has missing nutrition. Log the foods you ate instead.");
    }
    const scaled = evidence.value * ratio;
    if (!Number.isFinite(scaled)) throw new RangeError("That amount is too large to log.");
    macros[key] = scaled;
  }
  return { name: selection.recipeName, qty: actualServings, unit: "whole", role: "free", macros };
}
