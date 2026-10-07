import { describe, expect, it } from "vitest";
import { similarRecipeOptions } from "@/lib/foods/impact-ranking";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

describe("affected meal replacement ranking", () => {
  it("uses similar dishes only after the policy gate and excludes the original", () => {
    const recipes = pilotRecipes();
    const original = recipes.find((recipe) => recipe.recipeId === "egg-spinach-toast-plates")!;
    const candidates = recipes.map((recipe): RecipeCandidate => ({ ...recipe,
      eligibility: { status: recipe.recipeId === "lemon-chicken-rice-broccoli"
        ? "blocked" : "eligible", reasons: [] } }));
    const ranked = similarRecipeOptions(original, candidates, original.recipeId);
    expect(ranked).toHaveLength(3);
    expect(ranked.every((recipe) => recipe.eligibility.status === "eligible"
      && recipe.recipeId !== original.recipeId)).toBe(true);
    expect(ranked[0].cuisine).toBe("American");
  });
});
