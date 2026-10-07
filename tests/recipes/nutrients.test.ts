import { describe, expect, it } from "vitest";
import { computeRecipeNutrients, recipeInputGrams, recipeNutritionStatus, servingGrams,
  type Per100gByRef, type RecipeItemInput } from "@/lib/recipes/nutrients";

const rice: RecipeItemInput = { seq: 1, foodRefId: "rice", qty: 1, unit: "g", grams: 400, state: "cooked" };
const chicken: RecipeItemInput = { seq: 2, foodRefId: "chx", qty: 1, unit: "g", grams: 200, state: "cooked" };

const per100g = {
  rice: { energy_kcal: 130, protein: 2.7, carbohydrate: 28, fat_total: 0.3, fiber_total: 0.4 },
  chx: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6, fiber_total: null },
} as unknown as Per100gByRef;

describe("recipeInputGrams and servingGrams", () => {
  it("adds the item grams", () => {
    expect(recipeInputGrams([rice, chicken])).toBe(600);
  });

  it("divides the input weight by the servings when there is no yield", () => {
    expect(servingGrams(600, 4)).toBe(150);
  });

  it("uses the cooked yield when she weighed the tray", () => {
    expect(servingGrams(600, 4, 520)).toBe(130);
  });

  it("refuses zero servings", () => {
    expect(() => servingGrams(600, 0)).toThrow(RangeError);
  });
});

describe("computeRecipeNutrients", () => {
  it("divides the whole-recipe totals by the servings", () => {
    const { perServing } = computeRecipeNutrients([rice, chicken], per100g, 4);
    expect(perServing.energy_kcal).toBe(212.5);   // (520 + 330) / 4
    expect(perServing.protein).toBe(18.2);        // (10.8 + 62) / 4
  });

  it("keeps a per-serving amount identical whether or not she gave a yield weight", () => {
    const withYield = computeRecipeNutrients([rice, chicken], per100g, 4, 520);
    const without = computeRecipeNutrients([rice, chicken], per100g, 4);
    expect(withYield.perServing).toEqual(without.perServing);
  });

  it("sums the measured fiber and never reports the unmeasured item as zero", () => {
    const { perServing, coverage } = computeRecipeNutrients([rice, chicken], per100g, 4);
    expect(perServing.fiber_total).toBe(0.4);     // 1.6 g from the rice alone, over 4 servings
    expect(coverage).toBe(0.5);                   // fiber: 1 item of 2
    expect(coverage).toBeLessThan(1);
  });

  it("reports null, not zero, for a nutrient no item measured", () => {
    const noneMeasured = { rice: { iron: null }, chx: { iron: null } } as unknown as Per100gByRef;
    const { perServing } = computeRecipeNutrients([rice, chicken], noneMeasured, 4);
    expect(perServing.iron).toBeNull();
  });

  it("reports coverage 1 when every item measures every tracked macro", () => {
    const { coverage } = computeRecipeNutrients([rice], per100g, 2);
    expect(coverage).toBe(1);
  });

  it("reports coverage 0 for an empty recipe", () => {
    expect(computeRecipeNutrients([], per100g, 2)).toEqual({ perServing: {}, coverage: 0, nutritionComplete: false });
  });
});

describe("per-serving completeness (#21)", () => {
  it("marks the audit's probe partial: one 100 kcal item and one unmeasured item", () => {
    const a: RecipeItemInput = { seq: 1, foodRefId: "a", qty: 1, unit: "g", grams: 100, state: "raw" };
    const b: RecipeItemInput = { seq: 2, foodRefId: "b", qty: 1, unit: "g", grams: 100, state: "raw" };
    const probe = { a: { energy_kcal: 100, protein: 1, carbohydrate: 1, fat_total: 1, fiber_total: 1 },
      b: {} } as unknown as Per100gByRef;
    const result = computeRecipeNutrients([a, b], probe, 1);
    expect(result.perServing.energy_kcal).toBe(100);
    expect(result.coverage).toBe(0.5);
    expect(result.nutritionComplete).toBe(false);
  });

  it("is complete only when every item measured every tracked macro", () => {
    expect(computeRecipeNutrients([rice], per100g, 2).nutritionComplete).toBe(true);
    expect(computeRecipeNutrients([rice, chicken], per100g, 4).nutritionComplete).toBe(false);
    expect(computeRecipeNutrients([], per100g, 1).nutritionComplete).toBe(false);
  });

  it("reads a stored row's coverage; missing or malformed is unknown, never complete", () => {
    expect(recipeNutritionStatus({ energy_kcal: 50, coverage: 0.5 }))
      .toEqual({ coverage: 0.5, nutritionComplete: false });
    expect(recipeNutritionStatus({ coverage: 1 })).toEqual({ coverage: 1, nutritionComplete: true });
    expect(recipeNutritionStatus({ coverage: "1.0000" })).toEqual({ coverage: 1, nutritionComplete: true });
    expect(recipeNutritionStatus({ energy_kcal: 200 })).toEqual({ coverage: 0, nutritionComplete: false });
    expect(recipeNutritionStatus({ coverage: "x" })).toEqual({ coverage: 0, nutritionComplete: false });
    expect(recipeNutritionStatus(null)).toEqual({ coverage: 0, nutritionComplete: false });
  });
});
