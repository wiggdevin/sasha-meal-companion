import { describe, expect, it } from "vitest";
import { assertSupported } from "@/lib/ai/json-schema";
import {
  claimsAction,
  coachActionSchema,
  coachActionWireSchema,
  groundActions,
} from "@/lib/coach/actions";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const ACTION_ID = "3f1b1a2c-0000-4000-8000-0000000000a1";

describe("claimsAction", () => {
  it.each([
    ["Logged 150g rice for meal 1.", true],
    ["I've logged", true],
    ["I have logged", true],
    ["Added rice to meal 2.", true],
    ["Removed rice from meal 2.", true],
    ["Moved dinner to 7:30.", true],
    ["Updated slot meal-3.", true],
    ["Set meal 2 to 150g rice.", true],
    ["Changed the meal-2 slot.", true],
    ["Set a reminder", false],
    ["Changed my mind", false],
    ["Your meal 1 target is ready.", false],
  ])("classifies %j as %s", (reply, expected) => {
    expect(claimsAction(reply)).toBe(expected);
  });
});

describe("coachActionSchema", () => {
  it("refuses a missing or zero quantity for every action that sets grams", () => {
    expect(coachActionSchema.safeParse({
      kind: "log_meal", date: "2026-09-16", slot: "meal-1",
      items: [{ name: "steak" }],
    }).success).toBe(false);
    expect(coachActionSchema.safeParse({
      kind: "log_meal", date: "2026-09-16", slot: "meal-1",
      items: [{ name: "steak", grams: 0 }],
    }).success).toBe(false);
    expect(coachActionSchema.safeParse({
      kind: "add_slot_item", date: "2026-09-16", slot: "meal-2",
      item: { name: "rice", grams: 0 },
    }).success).toBe(false);
    expect(coachActionSchema.safeParse({
      kind: "set_slot_item", date: "2026-09-16", slot: "meal-2",
      name: "rice", grams: 0,
    }).success).toBe(false);
  });

  it("refuses negative quantities and quantities above 2000 grams", () => {
    for (const value of [-1, 2000.1]) {
      expect(coachActionSchema.safeParse({
        kind: "log_meal", date: "2026-09-16", slot: "meal-1",
        items: [{ name: "steak", grams: value }],
      }).success).toBe(false);
      expect(coachActionWireSchema.safeParse({
        kind: "set_slot_item", date: "2026-09-16", slot: "meal-1",
        name: "steak", grams: value,
      }).success).toBe(false);
    }
  });

  it("lowers its flat wire form and applies the strict check inside the parse", () => {
    expect(() => assertSupported(coachActionWireSchema)).not.toThrow();
    expect(coachActionWireSchema.safeParse({
      kind: "log_meal", date: "2026-09-16", slot: "meal-1",
      items: [{ name: "steak", grams: 170 }],
    }).success).toBe(true);
    expect(coachActionWireSchema.safeParse({
      kind: "log_meal", date: "2026-09-16", slot: "meal-1",
      items: [{ name: "steak", grams: 0 }],
    }).success).toBe(false);
  });
});

describe("groundActions", () => {
  it("drops a whole action with an ungrounded item and returns its clarification", async () => {
    const result = await groundActions("user-a", [{
      kind: "log_meal", date: "2026-09-16", slot: "meal-1",
      items: [{ name: "steak", grams: 170 }, { name: "unicorn egg", grams: 150 }],
    }], DEFAULT_PROFILE, {
      searchFoods: async (_userId, name) => name === "steak" ? [{
        foodRefId: "3f1b1a2c-0000-4000-8000-0000000000b1", name: "steak", brand: null,
        catalogFoodRevisionId: 41, kcalPer100g: 250, proteinPer100g: 26,
        carbsPer100g: 0, fatPer100g: 17, prefStatus: "eats",
      }] : [],
      newActionId: () => ACTION_ID,
    });

    expect(result.actions).toEqual([]);
    expect(result.clarifications).toEqual([
      'I could not find "unicorn egg" — what should I log it as?',
    ]);
  });

  it("keeps a blocked item in the action and names it in flagged", async () => {
    const result = await groundActions("user-a", [{
      kind: "add_slot_item", date: "2026-09-16", slot: "meal-2",
      item: { name: "cheese", grams: 30 },
    }], DEFAULT_PROFILE, {
      searchFoods: async () => [{
        foodRefId: "3f1b1a2c-0000-4000-8000-0000000000c1", name: "cheese", brand: null,
        catalogFoodRevisionId: 52, kcalPer100g: 402, proteinPer100g: 25,
        carbsPer100g: 1.3, fatPer100g: 33, prefStatus: null,
        allergenTags: ["dairy"], category: null,
      }],
      newActionId: () => ACTION_ID,
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      actionId: ACTION_ID, kind: "add_slot_item", flagged: ["cheese"],
      item: {
        name: "cheese", grams: 30,
        foodRefId: "3f1b1a2c-0000-4000-8000-0000000000c1",
        catalogFoodRevisionId: 52,
        kcalPer100g: 402, proteinPer100g: 25, carbsPer100g: 1.3, fatPer100g: 33,
        verdict: "blocked",
      },
    });
  });

  it("keeps grounded actions in a mixed batch and clarifies only the ungrounded one", async () => {
    const result = await groundActions("user-a", [
      { kind: "add_slot_item", date: "2026-09-16", slot: "meal-2",
        item: { name: "rice", grams: 150 } },
      { kind: "add_slot_item", date: "2026-09-16", slot: "meal-2",
        item: { name: "unicorn egg", grams: 100 } },
    ], DEFAULT_PROFILE, {
      searchFoods: async (_userId, name) => name === "rice" ? [{
        foodRefId: "3f1b1a2c-0000-4000-8000-0000000000b2", name, brand: null,
        catalogFoodRevisionId: 42, kcalPer100g: 130, proteinPer100g: 2.7,
        carbsPer100g: 28, fatPer100g: 0.3, prefStatus: "eats",
      }] : [],
      newActionId: () => ACTION_ID,
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ kind: "add_slot_item", item: { name: "rice" } });
    expect(result.clarifications).toEqual([
      'I could not find "unicorn egg" — what should I log it as?',
    ]);
  });

  // 2026-10-02 DeepSeek audit (F2, MED): lib/coach/policy.ts allergenFacts dropped a FoodHit's own
  // `brand` entirely — every grounding/log/suggestion lane that builds its policy evidence from a
  // search hit this way (ground-kit.ts groundNamedFood, among others) judged a branded product by
  // its plain-sounding name alone, clearing it through lib/policy/whole-foods.ts's whole-food
  // reading instead of staying unverified like the search/detail/barcode lanes already do.
  it("a branded hit never gets whole-food clearance when logged by name", async () => {
    const dairyAvoider = { ...DEFAULT_PROFILE, avoid_allergens: ["dairy"] };
    const result = await groundActions("user-a", [{
      kind: "log_meal", date: "2026-09-16", slot: "meal-1",
      items: [{ name: "Chicken breast", grams: 150 }],
    }], dairyAvoider, {
      searchFoods: async () => [{
        foodRefId: "3f1b1a2c-0000-4000-8000-0000000000d1", name: "Chicken breast",
        brand: "Acme Farms", catalogFoodRevisionId: 61, kcalPer100g: 165, proteinPer100g: 31,
        carbsPer100g: 0, fatPer100g: 3.6, prefStatus: null,
      }],
      newActionId: () => ACTION_ID,
    });

    expect(result.actions).toHaveLength(1);
    const action = result.actions[0] as { items: { verdict: string }[] };
    expect(action.items[0].verdict).toBe("unverified");
  });
});
