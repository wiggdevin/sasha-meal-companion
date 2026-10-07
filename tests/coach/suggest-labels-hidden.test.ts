/**
 * Phase 13 §5: suggestions exclude listed and unverified foods. When unchecked labels hide some or
 * all of them, the card keeps the verified alternatives it has and says so in one line.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import type { FoodHit } from "@/lib/coach/executors";
import { SUGGEST_BUILD_BUDGET_MS, suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import { LABELS_HIDDEN_MESSAGE } from "@/lib/coach/suggest-messages";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";

const PROFILE = { avoid_allergens: ["dairy", "gluten"], avoid_food_ref_ids: [],
  banned_categories: [] };
const TARGET = { kcal: 480, protein: 50, carbs: 50, fat: 8 };
const CHECKED = ["dairy", "gluten"];

function food(index: number, checked: boolean): FoodHit {
  return {
    foodRefId: `3f1b1a2c-0000-4000-8000-00000000001${index}`, name: `Protein ${index}`,
    brand: null, kcalPer100g: 240, proteinPer100g: 25, carbsPer100g: 25, fatPer100g: 4,
    prefStatus: "eats", catalogFoodRevisionId: index, allergenTags: [], category: [],
    portionGrams: 120, ...(checked ? { checkedAllergens: CHECKED } : {}),
  };
}

function ports(foods: FoodHit[]): SuggestPorts {
  const byName = new Map(foods.map((hit) => [hit.name.toLowerCase(), hit]));
  const byRef = new Map(foods.map((hit) => [hit.foodRefId, hit]));
  return {
    userId: "u1", profile: PROFILE, target: async () => TARGET,
    eatsNames: async () => foods.map((hit) => hit.name),
    searchFoods: async (_userId, query) => [byName.get(query.toLowerCase())]
      .filter((hit): hit is FoodHit => !!hit),
    systemOne: async () => null,
    suggestionEvidence: async (_userId, items) => ({
      status: "ready", preferenceFlags: [],
      byIdentity: Object.fromEntries(items.map((item) => [suggestionFoodIdentity(item), {
        allergenTags: [], policyCategories: [], noCook: null, onEatsList: true,
        onAvoidList: false, role: "protein" as const,
        checkedAllergens: byRef.get(item.foodRefId)?.checkedAllergens ?? [],
        facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } },
      }])),
    }),
  };
}

describe("suggestions with unchecked labels (Phase 13 §5)", () => {
  it("the Eats list alone no longer admits a food with no allergen evidence", async () => {
    const result = await suggestOptions({ kind: "meal", count: 3 },
      ports([food(1, false), food(2, false), food(3, false)]));
    expect(result).toHaveLength(0);
    expect((result as { message?: string }).message).toBe(LABELS_HIDDEN_MESSAGE);
  });

  it("keeps the verified alternatives and says the rest are hidden until their labels are checked",
    async () => {
      const result = await suggestOptions({ kind: "meal", count: 3 },
        ports([food(1, true), food(2, false), food(3, false)]));
      expect(result.map((card) => card.anchorProtein)).toEqual(["Protein 1"]);
      expect(result[0].shortfallNote).toBe(LABELS_HIDDEN_MESSAGE);
      expect(JSON.stringify(result).toLowerCase()).not.toContain("safe");
    });

  // 2026-10-01, production Plan sheet: every Eats protein was unverified for the account's gluten
  // and dairy avoids, the build ran its full 5 s budget, and the sheet said "I ran out of time"
  // instead of why there were no cards.
  it("says labels are hiding the foods even when the build ran out of time", async () => {
    vi.useFakeTimers();
    try {
      const foods = [food(1, false), food(2, false)];
      const fixture = ports(foods);
      const byName = new Map(foods.map((hit) => [hit.name, hit]));
      fixture.eatsNames = async () => [...foods.map((hit) => hit.name), "Slow 1", "Slow 2"];
      fixture.searchFoods = async (_userId, query) => byName.has(query) ? [byName.get(query)!]
        : new Promise<FoodHit[]>(() => {});
      const pending = suggestOptions({ kind: "meal", count: 3 }, fixture);
      await vi.advanceTimersByTimeAsync(SUGGEST_BUILD_BUDGET_MS);
      const result = await pending;
      expect(result).toHaveLength(0);
      expect((result as { message?: string }).message).toBe(LABELS_HIDDEN_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });
});
