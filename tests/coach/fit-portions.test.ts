import { describe, expect, it } from "vitest";
import type { ComposedItem, ComposedMeal } from "@/lib/coach/compose";
import { fitsTarget, macrosFor, type MealMacros } from "@/lib/coach/compose-size";
import { fitNamedMealPortions } from "@/lib/coach/fit-portions";

const CHICKEN = { name: "Chicken breast, cooked", kcal: 165, protein: 31, carbs: 0, fat: 3.6 };
const RICE = { name: "Rice, white, cooked", kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 };

function item(food: typeof CHICKEN, grams: number, index: number): ComposedItem {
  const per = { kcalPer100g: food.kcal, proteinPer100g: food.protein,
    carbsPer100g: food.carbs, fatPer100g: food.fat };
  return { name: food.name, foodRefId: `3f1b1a2c-0000-4000-8000-00000000000${index}`,
    catalogFoodRevisionId: null, grams, ...per, macros: macrosFor(per, grams),
    verdict: "allowed" };
}

function meal(items: ComposedItem[], target: MealMacros): ComposedMeal {
  const totals = items.reduce((sum, row) => ({
    kcal: sum.kcal + row.macros.kcal, protein: sum.protein + row.macros.protein,
    carbs: sum.carbs + row.macros.carbs, fat: sum.fat + row.macros.fat,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  return { wish: "Chicken and rice", slot: "meal-2", items, totals, target,
    flagged: [], fitsTarget: fitsTarget(totals, target), fitNote: null };
}

describe("fitNamedMealPortions sizes each item on its own", () => {
  it("resizes a meal over on carbs and under on protein into the 10 % bar", () => {
    const target = { kcal: 440, protein: 43.6, carbs: 50.4, fat: 5 };
    const before = meal([item(CHICKEN, 100, 0), item(RICE, 250, 1)], target);
    expect(before.totals.carbs).toBeGreaterThan(target.carbs * 1.1);
    expect(before.totals.protein).toBeLessThan(target.protein * 0.9);
    expect(before.fitsTarget).toBe(false);

    const fitted = fitNamedMealPortions(before);

    expect(fitted.fitsTarget).toBe(true);
    expect(fitted.fitNote).toBeNull();
    expect(fitted.target).toEqual(target);
    expect(fitted.items.map((row) => row.name)).toEqual([CHICKEN.name, RICE.name]);
    expect(fitted.items[0].grams).toBeGreaterThan(100);
    expect(fitted.items[1].grams).toBeLessThan(250);
    // The chicken is still the meal's protein, and the input meal is untouched.
    expect(fitted.items[0].macros.protein).toBeGreaterThan(fitted.items[1].macros.protein);
    expect(before.items.map((row) => row.grams)).toEqual([100, 250]);
    // Deterministic: the same meal resizes to the same grams.
    expect(fitNamedMealPortions(before).items.map((row) => row.grams))
      .toEqual(fitted.items.map((row) => row.grams));
  });

  it("still drops a meal that no portions of its foods can fit", () => {
    // Chicken alone carries no carbs; no grams of it reach a 50 g carb target.
    const target = { kcal: 450, protein: 35, carbs: 50, fat: 10 };
    const before = meal([item(CHICKEN, 120, 0)], target);

    const fitted = fitNamedMealPortions(before);

    expect(fitted.fitsTarget).toBe(false);
    expect(fitted).toBe(before);
  });

  it("does not stretch a portion past twice what was composed", () => {
    // Fitting would need ~3x the rice; the bound refuses rather than serving a mountain of it.
    const target = { kcal: 1100, protein: 47, carbs: 210, fat: 5 };
    const before = meal([item(CHICKEN, 120, 0), item(RICE, 250, 1)], target);

    expect(fitNamedMealPortions(before).fitsTarget).toBe(false);
  });
});
