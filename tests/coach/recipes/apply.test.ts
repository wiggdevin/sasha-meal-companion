import { beforeEach, describe, expect, it, vi } from "vitest";

const saveRecipe = vi.hoisted(() => vi.fn(async (_input: unknown) => (
  { recipeId: "recipe-1", rev: 1 }
)));

vi.mock("@/lib/recipes-client", () => ({ saveRecipe }));

import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import { applySaveRecipe } from "@/lib/coach/apply-entries";
import { filterRecipeActions } from "@/lib/coach/recipe-policy";
import type { SuggestionEvidence } from "@/lib/coach/suggest-policy";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const REF = (suffix: string) => `3f1b1a2c-0000-4000-8000-0000000000${suffix}`;

function grounded(
  name: string,
  ref: string,
  verdict: GroundedActionItem["verdict"],
): GroundedActionItem {
  return {
    name, foodRefId: ref, catalogFoodRevisionId: 1, grams: 100,
    kcalPer100g: 150, proteinPer100g: 18, carbsPer100g: 8, fatPer100g: 5, verdict,
  };
}

function action(
  items: GroundedActionItem[], refusals?: string[],
): Extract<CoachAction, { kind: "save_recipe" }> {
  return {
    kind: "save_recipe", actionId: "action-1", flagged: [], name: "Dinner", items,
    ...(refusals ? { refusals } : {}),
  };
}

describe("save_recipe persistence gate", () => {
  beforeEach(() => saveRecipe.mockClear());

  it("persists only allowed ingredients and returns every refusal on the action result", async () => {
    const refusals = [
      "Skipped smoked tofu: contains soy (your no-soy preference).",
      "Cannot verify chicken stock for your low-FODMAP preference — marked Not verified.",
    ];
    const result = await applySaveRecipe(action([
      grounded("chicken breast", REF("c1"), "allowed"),
      grounded("smoked tofu", REF("t1"), "blocked"),
      grounded("chicken stock", REF("s1"), "unverified"),
    ], refusals));

    expect(saveRecipe).toHaveBeenCalledOnce();
    const saved = saveRecipe.mock.calls[0]?.[0] as { items: { foodRefId: string }[] };
    expect(saved.items.map((item) => item.foodRefId))
      .toEqual([REF("c1")]);
    expect(result).toMatchObject({
      status: "applied",
      notices: refusals,
    });
  });

  it("does not create an empty recipe when every ingredient is refused", async () => {
    const result = await applySaveRecipe(action([
      grounded("smoked tofu", REF("t1"), "blocked"),
    ]));

    expect(saveRecipe).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "failed",
      reason: "Could not verify this recipe; try again.",
    });
  });

  it("fails closed without saving when a mixed recipe has no server refusals", async () => {
    const result = await applySaveRecipe(action([
      grounded("chicken breast", REF("c1"), "allowed"),
      grounded("smoked tofu", REF("t1"), "blocked"),
    ]));

    expect(saveRecipe).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "failed",
      reason: "Could not verify this recipe; try again.",
    });
  });

  it("refuses the whole recipe once server grounding marks any ingredient blocked or unverified", async () => {
    const chicken = grounded("chicken breast", REF("c1"), "allowed");
    const tofu = grounded("smoked tofu", REF("t1"), "allowed");
    const stock = grounded("chicken stock", REF("s1"), "allowed");
    const judgment = (p: number) => ({
      p, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00.000Z",
    });
    const evidence: SuggestionEvidence = {
      status: "ready", preferenceFlags: ["no_soy", "low_fodmap"],
      byIdentity: {
        [`ref:${chicken.foodRefId}`]: {
          allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"], policyCategories: [], noCook: true,
          onEatsList: true, onAvoidList: false, role: "protein",
          facets: { human_food: judgment(1), contains_soy: judgment(0),
            onion_garlic: judgment(0), beans: judgment(0) },
        },
        [`ref:${tofu.foodRefId}`]: {
          allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"], policyCategories: [], noCook: true,
          onEatsList: true, onAvoidList: false, role: "protein",
          facets: { human_food: judgment(1), contains_soy: judgment(1),
            onion_garlic: judgment(0), beans: judgment(0) },
        },
        [`ref:${stock.foodRefId}`]: {
          allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"], policyCategories: null, noCook: true,
          onEatsList: true, onAvoidList: false, role: null,
          facets: { human_food: judgment(1), contains_soy: judgment(0) },
        },
      },
    };
    const groundedActions = await filterRecipeActions(
      "u1", [action([chicken, tofu, stock])], DEFAULT_PROFILE, { evidence },
    );
    // GPT-6 Sol audit B2 (2026-10-04): saving chicken alone under the recipe's name would store a
    // different dish. The save is refused whole, with the reasons, and nothing reaches the phone.
    expect([tofu.verdict, stock.verdict]).toEqual(["allowed", "allowed"]);
    expect(groundedActions.actions).toEqual([]);
    expect(groundedActions.refusals.length).toBeGreaterThan(0);
    expect(saveRecipe).not.toHaveBeenCalled();
  });
});
