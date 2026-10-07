import { describe, expect, it } from "vitest";
import type { Food } from "@/lib/foods";
import { kcalPer100Label, NO_NUTRITION_LABEL, per100Base } from "@/lib/foods/display";
import { foodsFromSyncRows } from "@/lib/store";

const food = (over: Partial<Food>): Pick<Food, "name" | "unit" | "perUnit" | "nutritionUnknown"> =>
  ({ name: "Chicken breast, cooked", unit: "g", perUnit: { protein: 0.31, carbs: 0, fat: 0.036 }, ...over });

describe("calories per 100 g on Foods", () => {
  it("states a per-gram food per 100 g, never as a near-zero per gram", () => {
    // 0.31 g protein and 0.036 g fat a gram is 1.564 kcal a gram — it printed "2 kcal /1 g".
    expect(kcalPer100Label(food({}))).toBe("156 kcal / 100 g");
    expect(kcalPer100Label(food({ unit: "ml", name: "Milk", perUnit: { protein: 0.034, carbs: 0.05, fat: 0.01 } })))
      .toBe("43 kcal / 100 ml");
  });

  it("converts an ounce and a curated starter's household unit by their exact weight", () => {
    expect(kcalPer100Label(food({ unit: "oz", perUnit: { protein: 8.79, carbs: 0, fat: 1.02 } })))
      .toBe("156 kcal / 100 g");
    expect(kcalPer100Label(food({ name: "Banana", unit: "whole", perUnit: { protein: 1.3, carbs: 27, fat: 0.4 } })))
      .toBe("99 kcal / 100 g");
  });

  it("keeps the serving when the weight is not exact, and says so when there is no nutrition", () => {
    expect(per100Base({ name: "Homemade chili", unit: "cup" })).toEqual({ factor: 1, label: "1 cup" });
    expect(kcalPer100Label(food({ name: "Homemade chili", unit: "cup", perUnit: { protein: 20, carbs: 30, fat: 10 } })))
      .toBe("290 kcal / 1 cup");
    expect(kcalPer100Label(food({ name: "Honey", perUnit: { protein: 0, carbs: 0, fat: 0 }, nutritionUnknown: true })))
      .toBe(NO_NUTRITION_LABEL);
  });

  // 2026-10-04 audit (MINOR 11): water and diet soda read "No nutrition yet".
  it("states a measured zero as 0 kcal, and keeps the label for a row with no nutrition", () => {
    const zero = { protein: 0, carbs: 0, fat: 0 };
    expect(kcalPer100Label(food({ name: "Water", unit: "ml", perUnit: zero }))).toBe("0 kcal / 100 ml");
    expect(kcalPer100Label(food({ name: "Diet soda", perUnit: zero }))).toBe("0 kcal / 100 g");
    // Macros entered since the last sync print even while the stale flag is still set.
    expect(kcalPer100Label(food({ perUnit: { protein: 0.31, carbs: 0, fat: 0.036 }, nutritionUnknown: true })))
      .toBe("156 kcal / 100 g");
    const foods = foodsFromSyncRows(
      [{ id: "water", name: "Sparkling water", per_100g: { protein: 0, carbohydrate: 0, fat_total: 0, energy_kcal: 0 },
        deleted_at: null },
      { id: "blank", name: "Grandma's stew", per_100g: null, deleted_at: null },
      { id: "empty", name: "Mystery jar", per_100g: {}, deleted_at: null }],
      [], []);
    expect(foods.water.nutritionUnknown).toBeUndefined();
    expect(kcalPer100Label(foods.water)).toBe("0 kcal / 100 g");
    expect(foods.blank.nutritionUnknown).toBe(true);
    expect(kcalPer100Label(foods.blank)).toBe(NO_NUTRITION_LABEL);
    expect(kcalPer100Label(foods.empty)).toBe(NO_NUTRITION_LABEL);
  });
});
