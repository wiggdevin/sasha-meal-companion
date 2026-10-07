import { describe, expect, it } from "vitest";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { adaptRecipeServing } from "@/lib/recipes/adapt";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import { recipeEligibility } from "@/lib/recipes/eligibility";
import { aggregateShopping, identityKey } from "@/lib/shopping/aggregate";
import { identityFor, period } from "../shopping/fixture";

const pilot = pilotRecipes();
const stew = pilot.find((row) => row.recipeId === "beef-tomato-vegetable-stew")!;

describe("published pilot domain", () => {
  it("offers a complete stew to an unrestricted account with bundled identities", () => {
    const result = findRecipeCandidates(pilot, { query: "beef stew" },
      { profile: EMPTY_PROFILE });
    expect(result.candidates.map((row) => row.recipeId)).toContain(stew.recipeId);
    expect(result.candidates[0].ingredients.every((line) => line.foodRefId === null
      && line.catalogFoodRevisionId === null && Boolean(line.foodDbId))).toBe(true);
  });

  it("matches explicit Avoids by bundled ID or conservative base name", () => {
    expect(recipeEligibility(stew, { profile: EMPTY_PROFILE,
      explicitAvoidFoodDbIds: ["carrot-raw"] }).reasons)
      .toContainEqual(expect.objectContaining({ code: "avoid_list", ingredientSeq: 3 }));
    expect(recipeEligibility(stew, { profile: EMPTY_PROFILE,
      explicitAvoidNames: ["Carrots, raw"] }).reasons)
      .toContainEqual(expect.objectContaining({ code: "avoid_list", ingredientSeq: 3 }));
    expect(recipeEligibility(stew, { profile: EMPTY_PROFILE,
      explicitAvoidNames: ["carrot cake"] }).status).toBe("eligible");
  });

  it("fails closed when an active restriction lacks relevant evidence", () => {
    const result = findRecipeCandidates([stew], { query: "stew" },
      { profile: { ...EMPTY_PROFILE, avoid_allergens: ["dairy"] } });
    expect(result.candidates).toHaveLength(0);
    expect(result.excluded[0].eligibility).toMatchObject({ status: "unknown" });
    expect(result.excluded[0].eligibility.reasons.map((row) => row.code))
      .toContain("policy_unknown");
  });

  it("keeps FoodDB foods separate in shopping and scales sourced macros within bounds", () => {
    const shopping = aggregateShopping(period(), [{ recipe: stew, localDate: "2026-10-01",
      slotId: "dinner", batchId: "batch-1", servingsConsumed: 4 }], { identityFor });
    const identities = shopping.lines.map((line) => identityKey(line.identity!));
    expect(new Set(identities).size).toBe(stew.ingredients.length);
    expect(shopping.lines.find((line) => line.identity?.foodDbId === "carrot-raw")?.needGrams)
      .toBe(250);
    expect(shopping.lines.find((line) => line.identity?.foodDbId === "onion-raw")?.needGrams)
      .toBe(180);
    expect(shopping.lines.find((line) => line.identity?.foodDbId === "ground-beef-90-10-cooked")?.needGrams)
      .toBeNull();

    const half = adaptRecipeServing(stew, 0.5, { retainedFractionBySeq: {} });
    const full = adaptRecipeServing(stew, 1, { retainedFractionBySeq: {} });
    const double = adaptRecipeServing(stew, 2, { retainedFractionBySeq: {} });
    expect(full.approximateFitAvailable).toBe(true);
    expect(full.exactFitAvailable).toBe(false);
    expect(full.nutrition.kcal.status).toBe("estimated");
    expect(full.nutrition.kcal.value).toBeGreaterThan(0);
    expect(half.nutrition.kcal.value).toBeCloseTo(full.nutrition.kcal.value! / 2, 3);
    expect(double.nutrition.kcal.value).toBeCloseTo(full.nutrition.kcal.value! * 2, 3);
    expect(half.lines.map((line) => line.grams)).toEqual(
      full.lines.map((line) => line.grams! / 2));
    expect(full.lines[0].nutritionEvidence?.kcal.sourceKey)
      .toBe(`food-db:${stew.ingredients[0].foodDbId}`);
    expect(() => adaptRecipeServing(stew, 2.1, { retainedFractionBySeq: {} }))
      .toThrow(RangeError);
  });

  it("leaves genuinely missing nutrients unknown and rejects an invalid bundled identity", () => {
    const missing = { ...stew, ingredients: stew.ingredients.map((line, index) => index
      ? line : { ...line, nutrition: { ...line.nutrition,
        protein: { value: null, status: "unknown" as const, sourceRevisionId: null } } }) };
    const adapted = adaptRecipeServing(missing, 1, { retainedFractionBySeq: {} });
    expect(adapted.nutrition.protein).toMatchObject({ value: null, status: "unknown" });
    expect(adapted.approximateFitAvailable).toBe(false);
    const invalid = { ...stew, ingredients: stew.ingredients.map((line, index) => index
      ? line : { ...line, foodDbId: "no-such-food" }) };
    expect(recipeEligibility(invalid, { profile: EMPTY_PROFILE }).reasons)
      .toContainEqual(expect.objectContaining({ code: "unknown_identity", ingredientSeq: 1 }));
  });
});
