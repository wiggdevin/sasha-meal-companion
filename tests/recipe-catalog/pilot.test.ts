import { describe, expect, it } from "vitest";
import { FOOD_DB } from "@/lib/food-db";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { RECIPE_MACROS } from "@/lib/recipe-catalog/types";

describe("original pilot corpus", () => {
  it("contains complete authored methods, rights records, and numerical USDA-backed estimates", () => {
    const known = new Set(FOOD_DB.map((row) => row.id));
    const recipes = pilotRecipes();
    expect(recipes).toHaveLength(24);
    for (const recipe of recipes) {
      expect(recipe.source.rightsKind).toBe("original");
      expect(recipe.source.kitchenTested).toBe(false);
      expect(recipe.source.rightsRecord).toMatch(/not kitchen-tested/i);
      expect(recipe.steps.length).toBeGreaterThanOrEqual(3);
      expect(recipe.ingredients.length).toBeGreaterThanOrEqual(4);
      expect(recipe.servings).toBeGreaterThan(0);
      for (const item of recipe.ingredients) {
        expect(known.has(item.foodDbId ?? "")).toBe(true);
        expect(item.grams).toBeGreaterThan(0);
        expect(item.foodRefId).toBeNull(); // mapping occurs only after a unique real DB match
        for (const key of RECIPE_MACROS) {
          expect(item.nutrition[key].status).toBe("estimated");
          expect(item.nutrition[key].sourceKey).toBe(`food-db:${item.foodDbId}`);
          expect(item.nutrition[key].value).toBeTypeOf("number");
        }
      }
      for (const key of RECIPE_MACROS) {
        expect(recipe.nutritionPerServing[key].status).toBe("estimated");
        expect(recipe.nutritionPerServing[key].value).toBeTypeOf("number");
      }
    }
  });

  it("covers the fixed stew, vegetarian, no-cook, and time-bound cases", () => {
    const recipes = pilotRecipes();
    expect(recipes.some((r) => r.name.toLowerCase().includes("beef")
      && r.dishTags.includes("stew"))).toBe(true);
    expect(recipes.some((r) => r.dishTags.includes("stew")
      && r.dishTags.includes("vegetarian"))).toBe(true);
    expect(recipes.some((r) => r.effort === "none" && r.steps.every((s) =>
      !/\b(heat|cook|boil|toast|bake|fry|roast)\b/i.test(s.text)))).toBe(true);
    expect(recipes.some((r) => (r.totalMinutes ?? Infinity) <= 20)).toBe(true);
  });
});
