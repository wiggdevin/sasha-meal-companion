import { describe, expect, it } from "vitest";
import { avoidFoodDbIds } from "@/lib/recipe-catalog/avoid-food-db";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { dishSearchTerms } from "@/lib/recipe-catalog/query";
import { recipeSearchFromWish } from "@/lib/coach/recipe-query";
import { recipeEligibility } from "@/lib/recipes/eligibility";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { summarizeExclusions } from "@/lib/recipes/candidates";

describe("recipe catalog boundaries", () => {
  it("sends dish terms, not conversational filler, to SQL search", () => {
    expect(dishSearchTerms("find me a stew recipe please")).toEqual(["stew"]);
    // The occasion parser takes "for dinner" out first (O4a); a meal word left is part of a dish.
    expect(dishSearchTerms(recipeSearchFromWish(
      "can you please search for amazing stew recipes that I can eat for dinner").search.query))
      .toEqual(["stew"]);
    expect(dishSearchTerms("breakfast burrito")).toEqual(["breakfast", "burrito"]);
    expect(dishSearchTerms("show me a recipe")).toEqual([]);
  });

  it("blocks reviewed FoodDB Avoid aliases and keeps broad matches conservative", () => {
    const bread = pilotRecipes().find((recipe) => recipe.ingredients.some((item) =>
      item.foodDbId === "whole-wheat-bread"));
    expect(bread).toBeDefined();
    expect(avoidFoodDbIds(["Bread, whole-wheat"])).toContain("whole-wheat-bread");
    expect(avoidFoodDbIds(["Bread"])).toContain("whole-wheat-bread");
    expect(avoidFoodDbIds(["Bread"]).length).toBeGreaterThan(1);
    const input = { profile: EMPTY_PROFILE,
      explicitAvoidFoodDbIds: avoidFoodDbIds(["Bread, whole-wheat"]) };
    expect(recipeEligibility(bread!, input).reasons.some((entry) =>
      entry.code === "avoid_list")).toBe(true);
    const item = bread!.ingredients.find((ingredient) => ingredient.foodDbId === "whole-wheat-bread")!;
    expect(recipeEligibility(bread!, { profile: EMPTY_PROFILE,
      explicitAvoidNames: ["Whole wheat bread"] }).reasons.some((entry) =>
      entry.code === "avoid_list")).toBe(true);
    const foodRefId = crypto.randomUUID();
    const withRef = { ...bread!, ingredients: bread!.ingredients.map((ingredient) =>
      ingredient.seq === item.seq ? { ...ingredient, foodRefId, catalogFoodRevisionId: 1 }
        : ingredient) };
    expect(recipeEligibility(withRef, { profile: EMPTY_PROFILE,
      explicitAvoidFoodRefIds: [foodRefId] }).reasons.some((entry) =>
      entry.code === "avoid_list")).toBe(true);
  });

  it("keeps proven Avoid blocks separate from unavailable ingredient evidence", () => {
    const egg = pilotRecipes().find((recipe) => recipe.recipeId === "egg-spinach-toast-plates")!;
    const eligibility = recipeEligibility(egg, {
      profile: { ...EMPTY_PROFILE, banned_categories: ["simple_sugars"] },
      explicitAvoidFoodDbIds: ["egg-hard-boiled"], preferenceFlags: ["vegetarian"],
    });
    expect(eligibility.reasons.some((row) => row.code === "avoid_list")).toBe(true);
    expect(eligibility.reasons.some((row) => row.code === "facet_evidence")).toBe(true);
    const summary = summarizeExclusions([{ revisionId: egg.revisionId, eligibility }]);
    expect(summary).toEqual([
      "Some recipes conflict with your Avoid list or food rules.",
      "Some ingredients need preference or restriction evidence before they can be recommended.",
    ]);
  });

  it("enforces explicit cuisine and ingredient rules while guidance stays advisory", () => {
    const egg = pilotRecipes().find((recipe) => recipe.recipeId === "egg-spinach-toast-plates")!;
    const rules = [
      { id: crypto.randomUUID(), kind: "cuisine" as const, text: "American" },
      { id: crypto.randomUUID(), kind: "ingredient" as const, text: "egg" },
      { id: crypto.randomUUID(), kind: "guidance" as const, text: "gentle foods" },
    ];
    const verdict = recipeEligibility(egg, { profile: { ...EMPTY_PROFILE, custom_rules: rules } });
    expect(verdict.status).toBe("blocked");
    expect(verdict.reasons.some((row) => row.code === "custom_cuisine")).toBe(true);
    expect(verdict.reasons.some((row) => row.code === "policy_block" && /matches your rule against egg/.test(row.message))).toBe(true);
  });

  it("does not clear a cuisine exclusion when cuisine metadata is missing", () => {
    const recipe = pilotRecipes()[0];
    const verdict = recipeEligibility({ ...recipe, cuisine: null }, { profile: {
      ...EMPTY_PROFILE, custom_rules: [{ id: crypto.randomUUID(), kind: "cuisine", text: "American" }],
    } });
    expect(verdict.status).toBe("unknown");
    expect(verdict.reasons.some((row) => row.code === "cuisine_evidence")).toBe(true);
  });

  it("keeps an unmatched ingredient exclusion unknown without complete subingredient evidence", () => {
    const recipe = pilotRecipes()[0];
    const verdict = recipeEligibility(recipe, { profile: {
      ...EMPTY_PROFILE, custom_rules: [{ id: crypto.randomUUID(), kind: "ingredient", text: "peanut" }],
    } });
    expect(verdict.status).toBe("unknown");
    expect(verdict.reasons.some((row) => row.code === "ingredient_evidence")).toBe(true);
  });

  it("fails closed when a stored custom rule has an invalid shape", () => {
    const recipe = pilotRecipes()[0];
    const verdict = recipeEligibility(recipe, { profile: {
      ...EMPTY_PROFILE, custom_rules: [{ id: crypto.randomUUID(), kind: "ingredient",
        text: null } as never],
    } });
    expect(verdict.status).toBe("unknown");
    expect(verdict.reasons.some((row) => row.code === "invalid_rule")).toBe(true);
  });

  it("imports shopping routes and their Zod patch schemas without throwing", async () => {
    const [periods, lines, pantry] = await Promise.all([
      import("@/app/api/shopping/periods/route"),
      import("@/app/api/shopping/periods/[id]/lines/route"),
      import("@/app/api/shopping/pantry/route"),
    ]);
    expect(periods.POST).toBeTypeOf("function");
    expect(lines.POST).toBeTypeOf("function");
    expect(pantry.PUT).toBeTypeOf("function");
  });
});
