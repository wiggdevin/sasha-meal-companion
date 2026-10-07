import { describe, expect, it } from "vitest";
import { hydrateResolvedTool } from "@/lib/coach/blocks";
import { uiBlockSchema } from "@/lib/coach/ui-blocks";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

describe("recipe result blocks", () => {
  it("keeps complete shared candidates separate from name-only food ideas", () => {
    const recipe = { ...pilotRecipes()[0], eligibility: { status: "eligible" as const, reasons: [] } };
    const result = hydrateResolvedTool("suggest_options", { kind: "recipe" }, {
      candidates: [recipe], noResultReasons: [],
    }, { admin: {} as never, userId: "u1", date: "2026-09-27", tz: "America/Denver",
      context: null, profile: TEST_PROFILE, newId: () => "recipe-block" });
    expect(result.block).toMatchObject({ kind: "recipe_results", recipes: [recipe] });
    expect(uiBlockSchema.safeParse(result.block).success).toBe(true);
    expect(result.data).toMatchObject({ block: "recipe_results",
      recipes: [{ id: recipe.recipeId, name: recipe.name }] });
  });
  // O4a round 4: whether the cards are an exact match reaches the block and the model's tool result,
  // and stays optional so a result or a saved block without it still works.
  it.each([true, false])("carries exactMatch %s to the block and the tool result", (exactMatch) => {
    const recipe = { ...pilotRecipes()[0], eligibility: { status: "eligible" as const, reasons: [] } };
    const result = hydrateResolvedTool("suggest_options", { kind: "recipe" }, {
      candidates: [recipe], noResultReasons: [], exactMatch,
    }, { admin: {} as never, userId: "u1", date: "2026-09-27", tz: "America/Denver",
      context: null, profile: TEST_PROFILE, newId: () => "recipe-block" });
    expect(result.block).toMatchObject({ kind: "recipe_results", exactMatch });
    expect(result.data).toMatchObject({ block: "recipe_results", exactMatch });
    const parsed = uiBlockSchema.safeParse(result.block);
    expect(parsed.success && parsed.data.kind === "recipe_results" && parsed.data.exactMatch).toBe(exactMatch);
  });

  it("leaves exactMatch out when the result has none, and an old saved block still parses", () => {
    const recipe = { ...pilotRecipes()[0], eligibility: { status: "eligible" as const, reasons: [] } };
    const result = hydrateResolvedTool("suggest_options", { kind: "recipe" }, {
      candidates: [recipe], noResultReasons: [],
    }, { admin: {} as never, userId: "u1", date: "2026-09-27", tz: "America/Denver",
      context: null, profile: TEST_PROFILE, newId: () => "recipe-block" });
    expect(result.block).not.toHaveProperty("exactMatch");
    expect(result.data).not.toHaveProperty("exactMatch");
    const old = uiBlockSchema.safeParse({ kind: "recipe_results", v: 1, id: "saved", limitations: [],
      recipes: [recipe] });
    expect(old.success).toBe(true);
    const bad = uiBlockSchema.safeParse({ kind: "recipe_results", v: 1, id: "saved", limitations: [],
      recipes: [], exactMatch: "no" });
    expect(bad.success && bad.data.kind === "recipe_results" && bad.data.exactMatch).toBeUndefined();
  });

  it("drops malformed nested saved cards without rendering unverified source text", () => {
    const recipe = { ...pilotRecipes()[0], eligibility: { status: "eligible" as const, reasons: [] } };
    const block = { kind: "recipe_results", v: 1, id: "saved", limitations: [], recipes: [
      { ...recipe, ingredients: [{}] }, { ...recipe, source: {} },
      { ...recipe, publicationState: "published", nutritionPerServing: { kcal: {} } },
    ] };
    const parsed = uiBlockSchema.safeParse(block);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "recipe_results") expect(parsed.data.recipes).toEqual([]);
  });
});
