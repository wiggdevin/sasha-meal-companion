import { describe, expect, it } from "vitest";
import { gramsPerMl, gramsPerUnit } from "./units";

describe("gramsPerUnit — dimensional units", () => {
  it("resolves grams and ounces without a database lookup", () => {
    expect(gramsPerUnit("Anything at all", "g")).toBe(1);
    expect(gramsPerUnit("Anything at all", "oz")).toBeCloseTo(28.3495, 4);
  });

  it("weighs a curated liquid by its own density (audit N4)", () => {
    expect(gramsPerUnit("Olive oil", "ml")).toBe(0.92);
    expect(15 * gramsPerUnit("Olive oil", "ml")!).toBeCloseTo(13.8, 1);
    expect(gramsPerUnit("Honey", "ml")).toBe(1.42);
    expect(gramsPerUnit("Maple syrup", "ml")).toBe(1.32);
    expect(gramsPerUnit("Syrup, maple", "ml")).toBe(1.32);
    expect(gramsPerUnit("Heavy cream", "ml")).toBe(1.0);
    expect(gramsPerUnit("Milk, 2%", "ml")).toBe(1.03);
    expect(gramsPerUnit("Whole milk", "ml")).toBe(1.03);
    expect(gramsPerUnit("Oat milk", "ml")).toBe(1.0);
    expect(gramsPerUnit("Water", "ml")).toBe(1.0);
    // Case and spacing do not matter; the words do.
    expect(gramsPerMl("  OLIVE   oil ")).toBe(0.92);
  });

  it("covers every liquid in the bundled food list it names", () => {
    for (const name of ["Olive oil", "Avocado oil", "Canola oil", "Vegetable oil", "Sesame oil", "Whole milk",
      "2% milk", "Skim milk", "Heavy cream", "Almond milk, unsweetened", "Soy milk, unsweetened",
      "Oat milk (barista style)", "Coconut milk beverage", "Coffee, black", "Espresso", "Tea, black",
      "Green tea", "Water", "Chicken broth"]) {
      expect(gramsPerMl(name), name).not.toBeNull();
    }
  });

  it("fails closed: a name that only contains a liquid has no density (Grok round 7)", () => {
    expect(gramsPerUnit("Anything at all", "ml")).toBeNull();
    expect(gramsPerUnit("Grandma's tonic", "ml")).toBeNull();
    for (const name of ["Honey tea", "Honey lemon water", "Garlic honey tea", "Milk and honey", "Coffee yogurt",
      "Roasted peanut oil", "Pure maple syrup", "Agave syrup", "Milk chocolate", "Chocolate milk", "Cream cheese",
      "Honey mustard", "Ice cream, vanilla", "Whipped cream", "Cream of wheat", "Sweetened condensed milk",
      "Evaporated milk", "Sour cream", "Coffee beans", "Ground coffee", "Tea biscuit", "Milk thistle tea",
      "Honey bun", "Water chestnuts", "Orange juice", "Buttermilk"]) {
      expect(gramsPerMl(name), name).toBeNull();
    }
  });

  it("returns null for a household unit on a food it cannot find", () => {
    expect(gramsPerUnit("Grandma's stew", "cup")).toBeNull();
    expect(gramsPerUnit("Mystery bar", "whole")).toBeNull();
  });
});

describe("gramsPerUnit — household portions", () => {
  it("reads the portion row for a cup, a tablespoon and a whole item", () => {
    expect(gramsPerUnit("White rice, cooked", "cup")).toBe(158);
    expect(gramsPerUnit("Olive oil", "tbsp")).toBe(13.5);
    expect(gramsPerUnit("Eggs, large", "whole")).toBe(50);
    expect(gramsPerUnit("Banana, medium", "whole")).toBe(118);
  });

  it("doubles a half-cup portion and skips mashed and pureed labels", () => {
    expect(gramsPerUnit("White potato, peeled & boiled", "cup")).toBe(156);
    expect(gramsPerUnit("Sweet potato, peeled & cooked", "cup")).toBe(200);
  });

  it("resolves the pouch and the two oils the database does not carry", () => {
    expect(gramsPerUnit("Fruit pouch, pear or banana base", "pouch")).toBe(99);
    expect(gramsPerUnit("MCT oil", "tbsp")).toBe(14);
    expect(gramsPerUnit("Duck fat", "tbsp")).toBe(12.8);
  });

});

import { NUTRIENT_CODES } from "./nutrients/codes";
import { perUnitTo100g } from "./units";

describe("perUnitTo100g", () => {
  /* T9 §5: the keys are NUTRIENT_CODES, because compute_item_snapshot inner-joins
     jsonb_each(per_100g) on catalog_nutrients.code. The old `_g` spellings matched nothing
     there, so three of every four macros were dropped from the snapshot in silence. */
  it("scales one cup of white rice to per-100 g with Atwater energy", () => {
    expect(perUnitTo100g({ protein: 4.3, carbs: 44.5, fat: 0.4 }, 158)).toEqual({
      protein: 2.7,
      carbohydrate: 28.2,
      fat_total: 0.3,
      energy_kcal: 126,
    });
  });

  it("leaves a 100 g unit untouched", () => {
    expect(perUnitTo100g({ protein: 10, carbs: 20, fat: 5 }, 100)).toEqual({
      protein: 10,
      carbohydrate: 20,
      fat_total: 5,
      energy_kcal: 165,
    });
  });

  it("names only codes compute_item_snapshot can join on", () => {
    const keys = Object.keys(perUnitTo100g({ protein: 1, carbs: 1, fat: 1 }, 100)).sort();
    expect(keys).toEqual(["carbohydrate", "energy_kcal", "fat_total", "protein"]);
    for (const key of keys) expect(NUTRIENT_CODES).toContain(key);
  });

  it("refuses a non-positive gram weight rather than dividing by zero", () => {
    expect(() => perUnitTo100g({ protein: 1, carbs: 1, fat: 1 }, 0)).toThrow(
      "gramsPerUnit must be greater than zero"
    );
  });
});
