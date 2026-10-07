import { describe, expect, it } from "vitest";
import { FIBER_BAND_G, isNutrientCode, MACRO_CODES, NUTRIENT_CODES, NUTRIENT_UNITS,
  TRACKED_MICROS } from "./codes";

describe("nutrient codes", () => {
  it("carries the twenty canonical codes of contracts §2, in order", () => {
    expect(NUTRIENT_CODES).toEqual([
      "energy_kcal", "energy_kcal_calc", "protein", "carbohydrate", "fat_total", "fiber_total",
      "sugars_total", "sodium", "potassium", "calcium", "iron", "magnesium", "zinc", "vitamin_c",
      "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae", "saturated_fat", "cholesterol",
    ]);
  });

  it("gives every code a unit from the four the catalog uses", () => {
    for (const code of NUTRIENT_CODES) {
      expect(["kcal", "g", "mg", "µg"]).toContain(NUTRIENT_UNITS[code]);
    }
  });

  it("tracks exactly the twelve micros the DRI migration seeds", () => {
    expect(TRACKED_MICROS).toEqual([
      "fiber_total", "iron", "calcium", "potassium", "magnesium", "zinc", "vitamin_c",
      "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae", "sodium",
    ]);
    expect(TRACKED_MICROS).toHaveLength(12);
  });

  it("names the five macro codes Today's rings and fiber line read", () => {
    expect(MACRO_CODES).toEqual({ kcal: "energy_kcal", protein: "protein",
      carbs: "carbohydrate", fat: "fat_total", fiber: "fiber_total" });
  });

  it("holds her band, not the 25 g AI", () => {
    expect(FIBER_BAND_G).toEqual({ min: 20, max: 25 });
  });

  it("narrows an unknown string", () => {
    expect(isNutrientCode("protein")).toBe(true);
    expect(isNutrientCode("vitamin_k")).toBe(false);
  });
});
