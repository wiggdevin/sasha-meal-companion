import { describe, expect, it } from "vitest";
import { catalogWarmFood } from "@/lib/foods/catalog-ingredients";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { recipeEligibility } from "@/lib/recipes/eligibility";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";

describe("recipe catalog ingredient evidence", () => {
  it("blocks a named excluded ingredient hidden in a mapped catalog food", () => {
    const recipe = pilotRecipes()[0];
    const tomato = recipe.ingredients.find((item) => item.foodDbId === "crushed-tomatoes-canned")!;
    const food = catalogWarmFood({ id: 41, description: "Tomato sauce", brand: null,
      category: "Sauces", prep_state: null, catalog_portions: [],
      catalog_ingredients: [{ seq: 1, name: "tomatoes", raw_text: "Tomatoes, peanuts" }] });
    const profile = { ...EMPTY_PROFILE, custom_rules: [{ id: crypto.randomUUID(),
      kind: "ingredient" as const, text: "peanut" }] };
    const verdict = recipeEligibility(recipe, { profile, evidenceBySeq: {
      [tomato.seq]: { ingredientsText: food.ingredientsText,
        ingredientsTextIsLabel: food.labelComplete === true },
    } });
    expect(verdict.status).toBe("blocked");
    expect(verdict.reasons).toContainEqual(expect.objectContaining({ code: "policy_block",
      ingredientSeq: tomato.seq }));
  });

  it("does not manufacture an ingredient list or complete label from a public USDA row", () => {
    const food = catalogWarmFood({ id: 42, description: "Tomatoes, canned", brand: null,
      category: "Vegetables", prep_state: "canned", catalog_portions: [],
      catalog_ingredients: [] });
    expect(food.ingredientsText).toBeNull();
    expect(food.labelComplete).toBe(false);
  });

  it("keeps a composite catalog ingredient unverified when peanut subingredients are missing", () => {
    const recipe = pilotRecipes()[0];
    const tomato = recipe.ingredients.find((item) => item.foodDbId === "crushed-tomatoes-canned")!;
    const profile = { ...EMPTY_PROFILE, custom_rules: [{ id: crypto.randomUUID(),
      kind: "ingredient" as const, text: "peanut" }] };
    const verdict = recipeEligibility(recipe, { profile, evidenceBySeq: {
      [tomato.seq]: { ingredientsText: null, ingredientsTextIsLabel: false },
    } });
    expect(verdict.status).toBe("unknown");
    expect(verdict.reasons).toContainEqual(expect.objectContaining({ ingredientSeq: tomato.seq,
      code: "ingredient_evidence" }));
  });
});
