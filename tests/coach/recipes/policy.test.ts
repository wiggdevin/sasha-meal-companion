import { describe, expect, it, vi } from "vitest";

import { composeMeal, type ComposedItem } from "@/lib/coach/compose";
import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import {
  filterRecipeActions, filterRecipeMeal, recipeToolResult, rejectRecipeIngredients,
} from "@/lib/coach/recipe-policy";
import { hydrateFoodIdeas } from "@/lib/coach/blocks/hydrate-food-ideas";
import type { FoodHit } from "@/lib/coach/executors";
import type { SuggestionEvidence } from "@/lib/coach/suggest-policy";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const REF = (suffix: string) => `3f1b1a2c-0000-4000-8000-0000000000${suffix}`;
const TARGET = { kcal: 500, protein: 35, carbs: 45, fat: 18 };

function hit(name: string, ref: string): FoodHit {
  return {
    foodRefId: ref, name, brand: null, kcalPer100g: 150,
    proteinPer100g: 18, carbsPer100g: 8, fatPer100g: 5,
    prefStatus: "eats", catalogFoodRevisionId: 1, allergenTags: [], category: null,
    checkedAllergens: ["gluten", "dairy", "apple"],
  };
}

function item(name: string, ref: string): ComposedItem {
  return {
    name, foodRefId: ref, catalogFoodRevisionId: 1, grams: 100,
    kcalPer100g: 150, proteinPer100g: 18, carbsPer100g: 8, fatPer100g: 5,
    macros: { kcal: 150, protein: 18, carbs: 8, fat: 5 }, verdict: "allowed",
  };
}

const judgment = (p: number) => ({ p, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00.000Z" });

function facts(overrides: Partial<SuggestionEvidence["byIdentity"][string]> = {}) {
  return {
    allergenTags: [], policyCategories: [], facets: { human_food: judgment(1) },
    checkedAllergens: ["gluten", "dairy", "apple"],
    noCook: true, onEatsList: true, onAvoidList: false, role: null, ...overrides,
  } satisfies SuggestionEvidence["byIdentity"][string];
}

describe("recipe composition policy", () => {
  it("skips a facet-blocked ingredient, names the facet and preference, and keeps the rest", async () => {
    const chickenRef = REF("c1");
    const tofuRef = REF("t1");
    const evidence: SuggestionEvidence = {
      status: "ready", preferenceFlags: ["no_soy"],
      byIdentity: {
        // Phase 18 W2c: the food's own name decides (the loader always carries it); the Jev
        // facets below no longer block or clear anything.
        [`ref:${chickenRef}`]: facts({ foodName: "chicken breast", facets: {
          human_food: judgment(1),
          contains_soy: judgment(0),
        } }),
        [`ref:${tofuRef}`]: facts({ foodName: "smoked tofu", facets: {
          human_food: judgment(1),
          contains_soy: judgment(1),
        } }),
      },
    };

    const result = await rejectRecipeIngredients("u1", [
      item("chicken breast", chickenRef), item("smoked tofu", tofuRef),
    ], DEFAULT_PROFILE, { evidence });

    expect(result.items.map((food) => food.name)).toEqual(["chicken breast"]);
    expect(result.refusals).toEqual([{
      foodRefId: tofuRef,
      name: "smoked tofu",
      verdict: "blocked",
      facet: "contains_soy",
      preference: "no_soy",
      message: "Skipped smoked tofu: contains soy (your no-soy preference).",
    }]);
  });

  it("marks missing low-FODMAP evidence Not verified and names the preference", async () => {
    const stockRef = REF("s1");
    const evidence: SuggestionEvidence = {
      status: "ready", preferenceFlags: ["low_fodmap"],
      byIdentity: {
        [`ref:${stockRef}`]: facts({ policyCategories: null }),
      },
    };

    const result = await rejectRecipeIngredients(
      "u1", [item("chicken stock", stockRef)], DEFAULT_PROFILE, { evidence },
    );

    expect(result.items).toEqual([]);
    expect(result.refusals[0]).toMatchObject({
      verdict: "unverified", facet: "onion_garlic", preference: "low_fodmap",
      message: "Cannot verify chicken stock for your low-FODMAP preference — marked Not verified.",
    });
  });

  it("never lets a food on Avoid into a recipe", async () => {
    const avoidedRef = REF("a1");
    const evidence: SuggestionEvidence = {
      status: "ready", preferenceFlags: [],
      byIdentity: {
        [`ref:${avoidedRef}`]: facts({ onEatsList: false, onAvoidList: true }),
      },
    };

    const result = await rejectRecipeIngredients(
      "u1", [item("avoided food", avoidedRef)], DEFAULT_PROFILE, { evidence },
    );

    expect(result.items).toEqual([]);
    expect(result.refusals[0]).toMatchObject({
      verdict: "blocked", facet: "avoid_list", preference: "avoid_list",
      message: "Skipped avoided food: on your Avoid list.",
    });
  });

  it("returns refusal copy on the real tool payload without relying on the wish word", async () => {
    const chickenRef = REF("c1");
    const tofuRef = REF("t1");
    const evidence: SuggestionEvidence = {
      status: "ready", preferenceFlags: ["no_soy"],
      byIdentity: {
        // Phase 18 W2c: the food's own name decides (the loader always carries it); the Jev
        // facets below no longer block or clear anything.
        [`ref:${chickenRef}`]: facts({ foodName: "chicken breast", facets: {
          human_food: judgment(1),
          contains_soy: judgment(0),
        } }),
        [`ref:${tofuRef}`]: facts({ foodName: "smoked tofu", facets: {
          human_food: judgment(1),
          contains_soy: judgment(1),
        } }),
      },
    };
    const searchFoods = vi.fn(async (_userId: string, query: string) => {
      if (query === "chicken") return [hit("chicken breast", chickenRef)];
      if (query === "tofu") return [hit("smoked tofu", tofuRef)];
      return [];
    });

    const composed = await composeMeal("u1", {
      wish: "make me chicken and tofu for dinner", target: TARGET,
    }, DEFAULT_PROFILE, {
      searchFoods,
    });
    const filtered = await filterRecipeMeal("u1", composed, DEFAULT_PROFILE, { evidence });
    const toolPayload = recipeToolResult({ ok: true, block: "food_ideas" }, filtered.refusals);

    expect(filtered.meal?.items.map((food) => food.name)).toEqual(["chicken breast"]);
    expect(filtered.meal?.refusals).toEqual([
      "Skipped smoked tofu: contains soy (your no-soy preference).",
    ]);
    expect(toolPayload).toMatchObject({
      refusals: ["Skipped smoked tofu: contains soy (your no-soy preference)."],
    });
  });

  it("does not silently discard an Avoid-listed ingredient during composition", async () => {
    const avoidedRef = REF("a1");
    const avoided = { ...hit("avoided food", avoidedRef), prefStatus: "avoid" as const };
    const evidence: SuggestionEvidence = {
      status: "ready", preferenceFlags: [],
      byIdentity: {
        [`ref:${avoidedRef}`]: facts({ onEatsList: false, onAvoidList: true }),
      },
    };

    const composed = await composeMeal("u1", {
      wish: "make an avoided recipe", target: TARGET,
    }, DEFAULT_PROFILE, {
      searchFoods: async (_userId, query) => query === "avoided" ? [avoided] : [],
    });
    const filtered = await filterRecipeMeal("u1", composed, DEFAULT_PROFILE, { evidence });

    expect(filtered.meal).toBeNull();
    expect(filtered.refusals).toEqual(["Skipped avoided food: on your Avoid list."]);
    expect(hydrateFoodIdeas("recipe-card", filtered.meal ? [filtered.meal] : [])).toBeNull();
  });

  it("grounds refusal strings on the client action and emits no all-refused save action", async () => {
    const avoidedRef = REF("a1");
    const actionItem = {
      ...item("avoided food", avoidedRef),
      kcalPer100g: 150,
    } satisfies GroundedActionItem;
    const action: CoachAction = {
      kind: "save_recipe", actionId: "save-1", flagged: [], name: "Dinner",
      items: [actionItem],
    };
    const evidence: SuggestionEvidence = {
      status: "ready", preferenceFlags: [],
      byIdentity: {
        [`ref:${avoidedRef}`]: facts({ onEatsList: false, onAvoidList: true }),
      },
    };

    const grounded = await filterRecipeActions("u1", [action], DEFAULT_PROFILE, { evidence });

    expect(actionItem.verdict).toBe("allowed");
    expect(grounded.actions).toEqual([]);
    expect(grounded.refusals).toEqual(["Skipped avoided food: on your Avoid list."]);
  });

  it("never promotes a grounded blocked item when fresh evidence is empty", async () => {
    const avoidedRef = REF("a2");
    const action: CoachAction = {
      kind: "save_recipe", actionId: "save-2", flagged: ["avoided food"], name: "Dinner",
      items: [{
        ...item("avoided food", avoidedRef), kcalPer100g: 150, verdict: "blocked",
      } satisfies GroundedActionItem],
    };
    const evidence: SuggestionEvidence = {
      status: "ready", preferenceFlags: [], byIdentity: {},
    };

    const grounded = await filterRecipeActions("u1", [action], DEFAULT_PROFILE, { evidence });

    expect(grounded.actions).toEqual([]);
    expect(grounded.refusals).toEqual([
      "Skipped avoided food: not verified as human food.",
    ]);
  });

  it("finding: names the pregnancy/tuna mercury caption when only the food's OWN NAME says " +
    "tuna — explainRefusal's own evaluatePolicy call must carry foodName like every other site",
    async () => {
      const tunaRef = REF("t2");
      const pregnantProfile = { ...DEFAULT_PROFILE, avoid_allergens: [], conditions: ["pregnant"] };
      const evidence: SuggestionEvidence = {
        status: "ready", preferenceFlags: [],
        byIdentity: {
          // Ingredient text and tags name no tuna at all — only the product's own name does.
          [`ref:${tunaRef}`]: facts({ ingredientsText: "Water, salt.", foodName: "Canned tuna" }),
        },
      };

      const result = await rejectRecipeIngredients(
        "u1", [item("canned tuna", tunaRef)], pregnantProfile, { evidence },
      );

      expect(result.items).toEqual([]);
      expect(result.refusals[0]).toMatchObject({ verdict: "unverified" });
      expect(result.refusals[0].message).toBe(
        "Cannot verify canned tuna: unspecified tuna — mercury varies by species. Check the "
        + "label for the kind, or ask your clinician about mercury limits during pregnancy. "
        + "— marked Not verified.",
      );
    });
});
