/**
 * Phase 18 W10b (D8's caller table, "Where it lives and who calls it"): when the account's
 * quantized pref-2 values are available, `RECIPE_TASTE_POINTS × (T − 1)` over the recipe's
 * ingredients by grams replaces the favorite-food `+1` and the unused "usual" `+0.25` terms.
 * Absent (no caller wires this up yet), the original terms are untouched — proven already by
 * tests/recipes/favored-ingredient-ranks-first.test.ts.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import type { TasteValues } from "@/lib/meals/preference";
import { ingredient, recipe } from "./fixture";

describe("W10b: the recipe taste term", () => {
  it("ranks the recipe whose ingredient has a higher quantized taste value first", () => {
    const beef = recipe({ recipeId: "chili-beef", revisionId: "chili-beef-v1", name: "Chili",
      ingredients: [ingredient({ seq: 1, name: "ground beef" })] });
    const turkey = recipe({ recipeId: "chili-turkey", revisionId: "chili-turkey-v1", name: "Chili",
      ingredients: [ingredient({ seq: 1, name: "ground turkey" })] });
    const taste: TasteValues = { "ground turkey": { base: 1.5 }, "ground beef": { base: -0.5 } };

    const result = findRecipeCandidates([beef, turkey], { query: "chili", limit: 25 },
      { profile: EMPTY_PROFILE }, { taste, favoriteFoodRefIds: ["ground-beef".toLowerCase()] });

    // Even with an (ignored, now that `taste` is supplied) favorite-food ref match on beef, the
    // higher taste value wins: the old +1 term is replaced, not added alongside the new one.
    expect(result.candidates.map((row) => row.recipeId)).toEqual(["chili-turkey", "chili-beef"]);
  });

  it("keeps the favorite-RECIPE +3 term even with taste values present", () => {
    const liked = recipe({ recipeId: "liked", revisionId: "liked-v1", name: "Soup",
      ingredients: [ingredient({ seq: 1, name: "carrot" })] });
    const other = recipe({ recipeId: "other", revisionId: "other-v1", name: "Soup",
      ingredients: [ingredient({ seq: 1, name: "carrot" })] });
    const taste: TasteValues = { carrot: { base: 0 } };

    const result = findRecipeCandidates([liked, other], { query: "soup", limit: 25 },
      { profile: EMPTY_PROFILE }, { taste, favoriteRecipeIds: ["liked"] });

    expect(result.candidates.map((row) => row.recipeId)).toEqual(["liked", "other"]);
  });
});
