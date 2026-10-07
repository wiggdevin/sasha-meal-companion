import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import { recipeSearchFromWish } from "@/lib/coach/recipe-query";
import { recipe } from "./fixture";

describe("candidate search", () => {
  it("takes the real conversational Coach request through extraction and candidate ranking", () => {
    const wish = "can you please search for amazing stew recipes that I can eat for dinner";
    const parsed = recipeSearchFromWish(wish);
    expect(parsed).toMatchObject({ search: { query: "stew" }, unsupportedExclusion: false });
    expect(findRecipeCandidates([recipe(), recipe({ recipeId: "soup", revisionId: "soup-v1",
      name: "Tomato soup", dishTags: ["soup"] })], parsed.search,
    { profile: EMPTY_PROFILE }).candidates.map((row) => row.recipeId)).toEqual(["stew", "soup"]);
    expect(recipeSearchFromWish(`${wish} without onions`).unsupportedExclusion).toBe(true);
  });
  it("keeps discovery to three by default but offers the planner a bounded full pool", () => {
    const rows = Array.from({ length: 5 }, (_, index) => recipe({
      recipeId: `stew-${index}`, revisionId: `stew-${index}-v1`,
      name: `Stew ${index}`, }));
    expect(findRecipeCandidates(rows, { query: "stew" },
      { profile: EMPTY_PROFILE }).candidates).toHaveLength(3);
    expect(findRecipeCandidates(rows, { query: "stew", limit: 25 },
      { profile: EMPTY_PROFILE }).candidates).toHaveLength(5);
  });
  it("retains an eligible candidate beyond the first 25 names", () => {
    const blocked = Array.from({ length: 25 }, (_, index) => recipe({
      recipeId: `a-${index}`, revisionId: `a-${index}-v1`, name: `A dish ${index}`,
      ingredients: [recipe().ingredients[0], { ...recipe().ingredients[1], foodRefId: "avoid-me" }],
    }));
    const feasible = recipe({ recipeId: "z-feasible", revisionId: "z-feasible-v1",
      name: "Z feasible dish" });
    const found = findRecipeCandidates([...blocked, feasible], { query: "", limit: 64 },
      { profile: EMPTY_PROFILE, explicitAvoidFoodRefIds: ["avoid-me"] });
    expect(found.candidates.map((row) => row.recipeId)).toEqual(["z-feasible"]);
  });
  // O4a review round 3: the dish ranks (a favorite never outranks it); only time, cuisine, effort
  // and exclusions remove a recipe.
  it("ranks the dish above a favorite and honors cuisine, time and excludes", () => {
    const stew = recipe();
    const soup = recipe({ recipeId: "soup", revisionId: "soup-v1", name: "Tomato soup",
      dishTags: ["soup"], totalMinutes: 10 });
    const result = findRecipeCandidates([stew, soup], { query: "stew", cuisine: "Mediterranean",
      maxMinutes: 45 }, { profile: EMPTY_PROFILE }, { favoriteRecipeIds: ["soup"] });
    expect(result.candidates.map((row) => row.recipeId)).toEqual(["stew", "soup"]);
    expect(result.exactMatch).toBe(true);
    expect(findRecipeCandidates([stew], { query: "stew", maxMinutes: 20 },
      { profile: EMPTY_PROFILE }).candidates).toEqual([]);
  });

  it("does not let a favorite override an Avoid", () => {
    const result = findRecipeCandidates([recipe()], { query: "stew" },
      { profile: EMPTY_PROFILE, explicitAvoidFoodRefIds: ["beans"] },
      { favoriteRecipeIds: ["stew"] });
    expect(result.candidates).toHaveLength(0);
    expect(result.noResultReasons[0]).toMatch(/Avoid/);
  });

  it("keeps revision-specific ingredient evidence separate when sequences overlap", () => {
    const first = recipe({ recipeId: "a", revisionId: "a-v1" });
    const second = recipe({ recipeId: "b", revisionId: "b-v1" });
    const result = findRecipeCandidates([first, second], { query: "stew" },
      (row) => ({ profile: { ...EMPTY_PROFILE, banned_categories: ["sugary"] },
        evidenceBySeq: { 1: { category: row.recipeId === "a" ? ["sugary"] : [] },
          2: { category: [] } } }));
    expect(result.candidates.map((row) => row.recipeId)).toEqual(["b"]);
  });
});
