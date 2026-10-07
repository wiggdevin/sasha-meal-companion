/**
 * Owner decision (2026-10-02): plain whole foods clear for the allergens they cannot
 * contain. Live evidence of the bug this closes: an account avoiding gluten and dairy got zero
 * Eats protein suggestions, because every protein had an empty ingredient list and read
 * `no_evidence` — unverified — for both allergens regardless of what the food actually was.
 * Pattern follows tests/coach/suggest-labels-hidden.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import type { FoodHit } from "@/lib/coach/executors";
import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";

const PROFILE = { avoid_allergens: ["dairy", "gluten"], avoid_food_ref_ids: [],
  banned_categories: [] };
const TARGET = { kcal: 480, protein: 50, carbs: 50, fat: 8 };

function wholeFood(id: string, name: string): FoodHit {
  return {
    foodRefId: `3f1b1a2c-0000-4000-8000-00000000${id}`, name, brand: null,
    kcalPer100g: 240, proteinPer100g: 25, carbsPer100g: 25, fatPer100g: 4,
    prefStatus: "eats", catalogFoodRevisionId: 1, allergenTags: [], category: [],
    portionGrams: 120,
  };
}

function ports(foods: FoodHit[]): SuggestPorts {
  const byName = new Map(foods.map((hit) => [hit.name.toLowerCase(), hit]));
  return {
    userId: "u1", profile: PROFILE, target: async () => TARGET,
    eatsNames: async () => foods.map((hit) => hit.name),
    searchFoods: async (_userId, query) => [byName.get(query.toLowerCase())]
      .filter((hit): hit is FoodHit => !!hit),
    systemOne: async () => null,
    suggestionEvidence: async (_userId, items) => ({
      status: "ready", preferenceFlags: [],
      byIdentity: Object.fromEntries(items.map((item) => {
        const hit = foods.find((food) => food.foodRefId === item.foodRefId);
        return [suggestionFoodIdentity(item), {
          allergenTags: [], policyCategories: [], noCook: null, onEatsList: true,
          onAvoidList: false, role: "protein" as const,
          // No ingredient text and no brand — exactly the live-evidence shape ("Ahi tuna,
          // cooked" had ingredientsText empty, allergenTags [], category null). Only the plain
          // whole-food name itself is what lets gluten and dairy clear here.
          foodName: hit?.name ?? null, foodBrand: null, ingredientsText: "",
          facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } },
        }];
      })),
    }),
  };
}

describe("whole-food suggestions clear gluten and dairy by name alone (owner decision, 2026-10-02)", () => {
  it("an account avoiding gluten and dairy still gets cards built from plain whole-food anchors",
    async () => {
      const foods = [wholeFood("000001", "Ahi tuna, cooked"), wholeFood("000002", "Chicken breast"),
        wholeFood("000003", "Broccoli")];
      const result = await suggestOptions({ kind: "meal", count: 3 }, ports(foods));
      expect(result.length).toBeGreaterThan(0);
      expect(result.map((card) => card.anchorProtein)).toEqual(
        expect.arrayContaining(["Ahi tuna, cooked", "Chicken breast", "Broccoli"]),
      );
      expect((result as { message?: string }).message).toBeUndefined();
    });

  it("still withholds a food whose own name states the allergen (whey is dairy)", async () => {
    const foods = [wholeFood("000004", "Beverages, Protein powder whey based"),
      wholeFood("000005", "Chicken breast")];
    const result = await suggestOptions({ kind: "meal", count: 3 }, ports(foods));
    expect(result.map((card) => card.anchorProtein)).not.toContain(
      "Beverages, Protein powder whey based");
    expect(result.map((card) => card.anchorProtein)).toContain("Chicken breast");
  });

  // 2026-10-02 DeepSeek audit (F2, MED): a packaged row (a scanned barcode/label, or a branded/OFF
  // catalog source) must never get whole-food clearance by name alone, even with a blank brand.
  it("still withholds a packaged item with a plain-sounding name and no brand", async () => {
    const foods = [wholeFood("000006", "Chicken breast"), wholeFood("000007", "Broccoli")];
    const packagedPorts: SuggestPorts = {
      ...ports(foods),
      suggestionEvidence: async (_userId, items) => ({
        status: "ready", preferenceFlags: [],
        byIdentity: Object.fromEntries(items.map((item) => {
          const hit = foods.find((food) => food.foodRefId === item.foodRefId);
          return [suggestionFoodIdentity(item), {
            allergenTags: [], policyCategories: [], noCook: null, onEatsList: true,
            onAvoidList: false, role: "protein" as const,
            foodName: hit?.name ?? null, foodBrand: null, ingredientsText: "",
            packaged: hit?.name === "Chicken breast",
            facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } },
          }];
        })),
      }),
    };
    const result = await suggestOptions({ kind: "meal", count: 3 }, packagedPorts);
    expect(result.map((card) => card.anchorProtein)).not.toContain("Chicken breast");
    expect(result.map((card) => card.anchorProtein)).toContain("Broccoli");
  });
});
