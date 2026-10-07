/**
 * Anchor order (2026-10-02, live trace on the owner's account): the build walked the Eats list
 * alphabetically, spending a catalog search on every almond butter, avocado and shake mix to learn
 * it was not a protein, and ran out of its 5 s budget before reaching "Chicken breast" — and the
 * list it walked was capped at 40 names, so anything after "C" was never tried at all. The account's
 * own protein marks now come first, from an uncapped list.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import type { FoodHit } from "@/lib/coach/executors";
import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

function hit(name: string, index: number): FoodHit {
  return {
    foodRefId: `3f1b1a2c-0000-4000-8000-0000000003${String(index).padStart(2, "0")}`, name,
    brand: null, kcalPer100g: 240, proteinPer100g: 25, carbsPer100g: 25, fatPer100g: 4,
    prefStatus: "eats", catalogFoodRevisionId: index, allergenTags: [],
    checkedAllergens: ["gluten", "dairy", "apple"], category: [], portionGrams: 120,
  };
}

describe("suggestion anchors", () => {
  it("searches the account's protein anchors first and never the rest of the Eats list", async () => {
    const names = Array.from({ length: 30 }, (_, i) => `Almond butter ${i}`);
    const turkey = hit("Turkey breast", 1);
    const searchFoods = vi.fn(async (_userId: string, query: string) => query === "Turkey breast" ? [turkey] : []);
    const ports: SuggestPorts = {
      userId: "u1", profile: TEST_PROFILE, target: async () => ({ kcal: 480, protein: 50, carbs: 50, fat: 8 }),
      eatsNames: async () => [...names, "Turkey breast"],
      eatsAnchors: async () => ["Turkey breast"],
      searchFoods,
      systemOne: async () => null,
      suggestionEvidence: async (_userId, items) => ({ status: "ready", preferenceFlags: [],
        byIdentity: Object.fromEntries(items.map((item) => [suggestionFoodIdentity(item), {
          allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"], policyCategories: [],
          noCook: null, onEatsList: true, onAvoidList: false, role: "protein" as const,
          facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } },
        }])) }),
    };
    const cards = await suggestOptions({ kind: "meal", count: 1 }, ports);
    expect(cards.map((card) => card.anchorProtein)).toEqual(["Turkey breast"]);
    expect(searchFoods.mock.calls.map((call) => call[1])).not.toContain("Almond butter 0");
  });
});
