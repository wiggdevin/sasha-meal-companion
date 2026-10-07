import { describe, expect, it } from "vitest";
import { fitNamedMealPortions } from "@/lib/coach/suggest-candidates";
import type { ComposedMeal } from "@/lib/coach/compose";

describe("fitNamedMealPortions", () => {
  it("trims a near-fit meal to a selectable slot without changing its foods or target", () => {
    const target = { kcal: 445.5, protein: 30.5, carbs: 52.75, fat: 12.5 };
    const densities = [
      { kcal: 200, protein: 25, carbs: 20, fat: 5 },
      { kcal: 201, protein: 8, carbs: 30, fat: 5 },
      { kcal: 100, protein: 2.9, carbs: 9.2, fat: 3.6 },
    ];
    const meal: ComposedMeal = {
      wish: "Meal 4", slot: "meal-4", target,
      items: densities.map((density, index) => ({
        name: `Food ${index}`, foodRefId: `3f1b1a2c-0000-4000-8000-00000000000${index}`,
        catalogFoodRevisionId: null, grams: 100,
        kcalPer100g: density.kcal, proteinPer100g: density.protein,
        carbsPer100g: density.carbs, fatPer100g: density.fat,
        macros: density, verdict: "allowed" as const,
      })),
      totals: { kcal: 501, protein: 35.9, carbs: 59.2, fat: 13.6 },
      fitsTarget: false, flagged: [],
    };

    const fitted = fitNamedMealPortions(meal);

    expect(fitted.fitsTarget).toBe(true);
    expect(fitted.target).toEqual(target);
    expect(fitted.totals.kcal).toBeLessThan(501);
    expect(fitted.items.map((item) => [item.foodRefId, item.verdict])).toEqual(
      meal.items.map((item) => [item.foodRefId, item.verdict]));
    expect(meal.items.every((item) => item.grams === 100)).toBe(true);
  });
});
