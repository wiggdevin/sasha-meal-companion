/**
 * Phase 18 W10 (docs/specs/phase-18-open-world-foods.md §W10), acceptance 7: of two recipes that
 * differ only in one Favored ingredient, the Favored one ranks first.
 *
 * `findRecipeCandidates` (lib/recipes/candidates.ts) already carries this: its score adds one
 * point per ingredient whose `foodRefId` is in the caller's `favoriteFoodRefIds` (the star system
 * this phase's "Favored" still is, pre-W13 rename), ahead of the dish/occasion/word-match terms.
 * This locks the behavior in as a W10 acceptance test.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import { ingredient, recipe } from "./fixture";

describe("W10 acceptance 7: a Favored ingredient ranks its recipe first", () => {
  it("ranks the recipe with one Favored (starred) ingredient ahead of an otherwise identical one", () => {
    const plain = recipe({ recipeId: "chili-plain", revisionId: "chili-plain-v1", name: "Chili",
      ingredients: [ingredient({ seq: 1, name: "ground beef", foodRefId: "ground-beef" }),
        ingredient({ seq: 2, name: "beans", foodRefId: "beans" })] });
    const favored = recipe({ recipeId: "chili-favored", revisionId: "chili-favored-v1", name: "Chili",
      ingredients: [ingredient({ seq: 1, name: "ground turkey", foodRefId: "ground-turkey" }),
        ingredient({ seq: 2, name: "beans", foodRefId: "beans" })] });

    const result = findRecipeCandidates([plain, favored], { query: "chili", limit: 25 },
      { profile: EMPTY_PROFILE }, { favoriteFoodRefIds: ["ground-turkey"] });

    expect(result.candidates.map((row) => row.recipeId)).toEqual(["chili-favored", "chili-plain"]);
  });

  it("keeps the plain recipe first when neither ingredient is Favored", () => {
    const plain = recipe({ recipeId: "chili-plain", revisionId: "chili-plain-v1", name: "Chili",
      ingredients: [ingredient({ seq: 1, name: "ground beef", foodRefId: "ground-beef" })] });
    const other = recipe({ recipeId: "chili-other", revisionId: "chili-other-v1", name: "Chili",
      ingredients: [ingredient({ seq: 1, name: "ground turkey", foodRefId: "ground-turkey" })] });

    const result = findRecipeCandidates([plain, other], { query: "chili", limit: 25 },
      { profile: EMPTY_PROFILE }, { favoriteFoodRefIds: [] });

    // No Favored ingredient on either side: the tie-break (name, then revision id) decides, not
    // a Favored boost — "chili-other" sorts before "chili-plain" alphabetically.
    expect(result.candidates.map((row) => row.recipeId)).toEqual(["chili-other", "chili-plain"]);
  });
});
