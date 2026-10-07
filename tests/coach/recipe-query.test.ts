import { describe, expect, it } from "vitest";
import { recipeSearchFromWish } from "@/lib/coach/recipe-query";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { occasionFit, recipeOccasions, wishOccasion } from "@/lib/recipes/occasion";
import { MEAL_WORDS } from "@/lib/meals/occasion-phrase";
import { recipe } from "../recipes/fixture";
import { dishSearchTerms } from "@/lib/recipe-catalog/query";

describe("Coach recipe search filters", () => {
  it("extracts a dish, time limit and no-cook effort for the shared candidate service", () => {
    expect(recipeSearchFromWish("Find me a chicken stew recipe under 30 minutes, no-cook", 5))
      .toEqual({ search: { query: "chicken stew", limit: 3,
        maxMinutes: 30, effort: "none" }, unsupportedExclusion: false });
  });
  it("does not silently ignore a one-off ingredient exclusion", () => {
    expect(recipeSearchFromWish("chicken stew without onions").unsupportedExclusion).toBe(true);
    for (const wish of ["chicken stew no onions", "chicken stew with no onions",
      "chicken stew but no onions"]) {
      expect(recipeSearchFromWish(wish).unsupportedExclusion).toBe(true);
    }
    expect(recipeSearchFromWish("chicken stew no-cook").unsupportedExclusion).toBe(false);
    expect(recipeSearchFromWish("chicken stew without cooking").unsupportedExclusion).toBe(false);
  });
  it("reads a no-cook wish with words in between as an effort, not an exclusion", () => {
    for (const wish of ["chicken stew without any cooking", "a meal without needing to cook",
      "dinner without having to cook", "lunch with no cooking"]) {
      const parsed = recipeSearchFromWish(wish);
      expect(parsed.unsupportedExclusion, wish).toBe(false);
      expect(parsed.search.effort, wish).toBe("none");
    }
    const little = recipeSearchFromWish("dinner without much cooking");
    expect(little.unsupportedExclusion).toBe(false);
    expect(little.search.effort).toBe("minimal");
    expect(recipeSearchFromWish("chicken stew without any cooking").search.query).toBe("chicken stew");
    expect(recipeSearchFromWish("no-cook salad without onions").unsupportedExclusion).toBe(true);
  });
  it("keeps the full stew request's dish while preserving cuisine and time constraints", () => {
    const full = recipeSearchFromWish("can you please search for amazing stew recipes that I can eat for dinner");
    expect(full.search.query).toBe("stew");
    const found = findRecipeCandidates(pilotRecipes(), full.search, { profile: EMPTY_PROFILE });
    expect(found.candidates.length).toBeGreaterThan(0);
    expect(found.candidates.every((row) => row.name.toLowerCase().includes("stew"))).toBe(true);
    expect(recipeSearchFromWish("Find an Italian stew for dinner under 30 minutes").search)
      .toMatchObject({ query: "stew", cuisine: "italian", maxMinutes: 30 });
  });
});

describe("meal words rank by the recipe's meal type (Phase 17 O4, acceptance 10)", () => {
  const recipes = pilotRecipes();
  const rank = (wish: string, limit = 3) => findRecipeCandidates(recipes,
    { ...recipeSearchFromWish(wish).search, limit }, { profile: EMPTY_PROFILE }).candidates;

  it("reads a meal word as the occasion, not as a dish term", () => {
    expect(recipeSearchFromWish("easy breakfast").search).toEqual({ query: "easy", limit: 3, occasion: "breakfast" });
    expect(recipeSearchFromWish("a quick snack").search.occasion).toBe("snack");
    expect(recipeSearchFromWish("salmon for tonight").search).toMatchObject({ query: "salmon", occasion: "dinner" });
    expect(recipeSearchFromWish("chicken stew").search.occasion).toBeUndefined();
    expect(wishOccasion("brunch ideas")).toBe("breakfast");
    expect(wishOccasion("supper")).toBe("dinner");
  });

  it("\"easy breakfast\": easy breakfasts first, then the other easy recipes, then breakfasts", () => {
    // Round 3: query words rank above the meal ("easy" is a word, breakfast the occasion).
    const all = rank("easy breakfast", 64);
    expect(all.length).toBe(rank("", 64).length);
    const easy = (row: { dishTags: readonly string[]; name: string }) =>
      row.dishTags.includes("easy") || /easy/i.test(row.name);
    const tier = (row: { dishTags: readonly string[]; name: string }) =>
      (easy(row) ? 0 : 2) + (recipeOccasions(row).has("breakfast") ? 0 : 1);
    expect(recipeOccasions(all[0]).has("breakfast") && easy(all[0])).toBe(true);
    const easyCount = all.filter(easy).length;
    expect(all.slice(0, easyCount).every(easy)).toBe(true);
    const tiers = all.map(tier);
    expect(tiers.slice(0, easyCount)).toEqual([...tiers.slice(0, easyCount)].sort());
  });

  it("ranks, never filters: a plain \"breakfast\" still offers the other meals after breakfasts", () => {
    const all = rank("breakfast", 64);
    expect(all.length).toBe(rank("", 64).length);
    expect(recipeOccasions(all[0]).has("breakfast")).toBe(true);
    expect(all.some((recipe) => recipeOccasions(recipe).has("dinner"))).toBe(true);
  });

  it("scores lunch and dinner as near, untagged as unknown, other meals as no fit", () => {
    expect(occasionFit({ dishTags: ["egg", "breakfast"] }, "breakfast")).toBe(1);
    expect(occasionFit({ dishTags: ["steak", "lunch"] }, "dinner")).toBe(0.5);
    expect(occasionFit({ dishTags: ["steak", "dinner"] }, "other")).toBe(0.5);
    expect(occasionFit({ dishTags: ["stew"] }, "breakfast")).toBe(0.25);
    expect(occasionFit({ dishTags: ["oats", "breakfast"] }, "dinner")).toBe(0);
  });

  it("strips the whole meal phrase from the dish query, modifiers included (shared parser)", () => {
    expect(recipeSearchFromWish("salmon at lunch").search).toEqual({ query: "salmon", limit: 3, occasion: "lunch" });
    expect(recipeSearchFromWish("salmon for a late dinner").search)
      .toEqual({ query: "salmon", limit: 3, occasion: "dinner" });
    expect(recipeSearchFromWish("chicken for an early lunch").search).toMatchObject({ query: "chicken", occasion: "lunch" });
    expect(recipeSearchFromWish("eggs as a snack").search).toMatchObject({ query: "eggs", occasion: "snack" });
    expect(recipeSearchFromWish("eggs as a quick snack").search).toMatchObject({ query: "eggs", occasion: "snack" });
    expect(recipeSearchFromWish("something for brunch").search).toMatchObject({ query: "something", occasion: "breakfast" });
    expect(recipeSearchFromWish("for brunch").search).toEqual({ query: "", limit: 3, occasion: "breakfast" });
  });

  it("keeps a meal word that is part of the dish, and the explicit phrase names the meal", () => {
    expect(recipeSearchFromWish("breakfast burrito for dinner").search)
      .toEqual({ query: "breakfast burrito", limit: 3, occasion: "dinner" });
    expect(recipeSearchFromWish("breakfast burrito").search)
      .toEqual({ query: "breakfast burrito", limit: 3, occasion: "breakfast" });
  });

  it("leaves no time word behind as a dish filter (review round 1 BLOCK 2)", () => {
    expect(recipeSearchFromWish("chicken for dinner tomorrow night").search)
      .toEqual({ query: "chicken", limit: 3, occasion: "dinner" });
    expect(rank("chicken for dinner tomorrow night", 64).length).toBe(rank("chicken for dinner", 64).length);
    expect(rank("chicken for dinner", 64).length).toBeGreaterThan(0);
  });

  it("a meal word the parser takes as the occasion never reaches the query (review round 1 BLOCK 3)", () => {
    expect(recipeSearchFromWish("dinnertime stew").search).toMatchObject({ occasion: "dinner" });
    expect(rank("dinnertime stew", 64).length).toBe(rank("stew", 64).length);
    expect(dishSearchTerms(recipeSearchFromWish("easy breakfast").search.query)).toEqual(["easy"]);
    expect(MEAL_WORDS.length).toBeGreaterThan(0);
  });

  it("\"breakfast for dinner\": breakfast is the food asked for, so it ranks first; nothing is removed", () => {
    const all = rank("breakfast for dinner", 64);
    expect(recipeSearchFromWish("breakfast for dinner").search).toMatchObject({ query: "breakfast", occasion: "dinner" });
    expect(all.length).toBe(rank("", 64).length);
    expect(recipeOccasions(all[0]).has("breakfast")).toBe(true);
    expect(all.some((recipe) => recipeOccasions(recipe).has("dinner"))).toBe(true);
  });

  it("keeps a meal word that is part of a dish name as a ranked word (O4a round 4)", () => {
    const burrito = (name: string, meal: string, id: string) => recipe({ recipeId: id, revisionId: `${id}-v1`,
      name, dishTags: ["burrito", meal] });
    const breakfastBurrito = burrito("Breakfast burrito", "breakfast", "bb");
    const dinnerBurrito = burrito("Dinner burrito", "dinner", "db");
    const search = { ...recipeSearchFromWish("breakfast burrito for dinner").search, limit: 5 };
    const both = findRecipeCandidates([dinnerBurrito, breakfastBurrito], search, { profile: EMPTY_PROFILE });
    expect(both.candidates.map((row) => row.name)).toEqual(["Breakfast burrito", "Dinner burrito"]);
    expect(both.exactMatch).toBe(true);
    const onlyDinner = findRecipeCandidates([dinnerBurrito], search, { profile: EMPTY_PROFILE });
    expect(onlyDinner.candidates.map((row) => row.name)).toEqual(["Dinner burrito"]);
    expect(onlyDinner.exactMatch).toBe(false);
  });
});
