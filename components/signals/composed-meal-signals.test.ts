/** Phase 18 W6 UI: the shared slate builder for Plan-sheet ideas and coach suggestion cards. */
import { describe, expect, it } from "vitest";
import { composedMealKey, composedMealSignalEvents } from "@/components/signals/composed-meal-signals";
import type { ComposedMeal } from "@/lib/coach/compose";

function meal(wish: string, items: Partial<ComposedMeal["items"][number]>[]): ComposedMeal {
  return {
    wish, slot: "meal-2",
    items: items.map((item) => ({
      name: item.name ?? wish, foodRefId: item.foodRefId ?? crypto.randomUUID(),
      catalogFoodRevisionId: item.catalogFoodRevisionId ?? null, grams: 150,
      kcalPer100g: 120, proteinPer100g: 10, carbsPer100g: 5, fatPer100g: 3,
      macros: { kcal: 180, protein: 15, carbs: 7, fat: 4 }, verdict: "allowed", ...item,
    })) as ComposedMeal["items"],
    totals: { kcal: 180, protein: 15, carbs: 7, fat: 4 },
    target: { kcal: 400, protein: 30, carbs: 40, fat: 10 },
    flagged: [], fitsTarget: true,
  } as ComposedMeal;
}

describe("composedMealKey", () => {
  it("is undefined for a free-text idea whose item was never grounded to a food (no foodKey)", () => {
    expect(composedMealKey(meal("Rice bowl", [{ name: "Rice" }]))).toBeUndefined();
  });

  it("reads an item's own foodKey (PR #463: ComposedItem carries one once grounded)", () => {
    const withKey = meal("Rice bowl", [{ name: "Rice", foodKey: "food:11111111-1111-4111-8111-111111111111" }]);
    expect(composedMealKey(withKey)).toBe("food:11111111-1111-4111-8111-111111111111");
  });

  it("ignores a malformed foodKey rather than trusting the wire shape", () => {
    const malformed = meal("Rice bowl", [{ name: "Rice", foodKey: "not-a-real-key" }]);
    expect(composedMealKey(malformed)).toBeUndefined();
  });
});

describe("composedMealSignalEvents", () => {
  it("sends nothing when no item in the slate carries a resolvable food key (a free-text idea)", () => {
    const slate = [meal("Rice bowl", [{ name: "Rice" }]), meal("Chicken plate", [{ name: "Chicken" }])];
    expect(composedMealSignalEvents({ slateId: "s1", surface: "plan_sheet", kind: "added",
      slate, chosen: slate[0], occasion: "lunch",
      rankingVersion: "plan-sheet-v1" })).toEqual([]);
  });

  it("sends the one event once items carry resolvable keys", () => {
    const keyed = [
      meal("Rice bowl", [{ name: "Rice", foodKey: "food:11111111-1111-4111-8111-111111111111" }]),
      meal("Chicken plate", [{ name: "Chicken", foodKey: "catalog:42" }]),
    ];
    const events = composedMealSignalEvents({ slateId: "s1", surface: "suggestion_card", kind: "picked",
      slate: keyed, chosen: keyed[1], occasion: "dinner",
      rankingVersion: "suggestion-card-v1" });
    expect(events).toEqual([{ slateId: "s1", surface: "suggestion_card", kind: "picked",
      occasion: "dinner", chosenKey: "catalog:42",
      offeredKeys: ["food:11111111-1111-4111-8111-111111111111", "catalog:42"],
      rankingVersion: "suggestion-card-v1" }]);
  });

  it("sends nothing when the chosen meal's key is not in the built slate", () => {
    const keyed = [
      meal("Rice bowl", [{ name: "Rice", foodKey: "food:11111111-1111-4111-8111-111111111111" }]),
      meal("Chicken plate", [{ name: "Chicken", foodKey: "catalog:42" }]),
    ];
    const outOfSlate = meal("Not offered",
      [{ name: "Something else", foodKey: "food:22222222-2222-4222-8222-222222222222" }]);
    expect(composedMealSignalEvents({ slateId: "s1", surface: "plan_sheet", kind: "not_this",
      slate: keyed, chosen: outOfSlate, occasion: "lunch",
      rankingVersion: "plan-sheet-v1" })).toEqual([]);
  });
});
