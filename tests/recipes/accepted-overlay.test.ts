import { describe, expect, it } from "vitest";
import { withAcceptedRecipeSelections } from "@/lib/recipes/accepted-overlay";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { Store } from "@/lib/types";
import { defaultStore } from "@/lib/store";
import { resolveDay } from "@/lib/resolve";

const selection: AcceptedRecipeSelection = {
  id: "selection", localDate: "2026-10-01", slotId: "meal-3", recipeId: "recipe",
  recipeRevisionId: "revision", recipeName: "Stew", servingFraction: 1,
  ingredientSnapshot: [{ seq: 1, name: "Beans", foodRefId: null, foodDbId: "beans",
    foodRevisionId: null, quantity: 1, unit: "cup", grams: 180,
    purchaseGrams: 180, state: "raw" },
  { seq: 2, name: "Salt", foodRefId: null, foodDbId: "salt",
    foodRevisionId: null, quantity: 0.25, unit: "tsp", grams: 1.5,
    purchaseGrams: 1.5, state: "raw" }],
  nutritionSnapshot: Object.fromEntries(Object.entries({ kcal: 300, protein: 20,
    carbs: 40, fat: 8 }).map(([key, value]) => [key,
    { value, status: "estimated", sourceRevisionId: null }])),
  exactFitAvailable: false, approximateFitAvailable: true, evidenceIssues: [], planRevision: 1,
};

describe("accepted recipe phone projection", () => {
  it("shows one atomic accepted portion without mutating saved rows", () => {
    const store = { days: { "2026-10-01": { date: "2026-10-01",
      notes: { "meal-3": "less salt" } } } } as unknown as Store;
    const projected = withAcceptedRecipeSelections(store, [selection]);
    expect(projected.days["2026-10-01"].itemOverrides?.["meal-3"]?.title).toBe("Stew");
    expect(projected.days["2026-10-01"].itemOverrides?.["meal-3"]?.components
      .map((row) => [row.name, row.qty, row.unit])).toEqual([
        ["Stew", 1, "whole"]]);
    expect(projected.days["2026-10-01"].notes?.["meal-3"]).toBe("less salt");
    expect(store.days["2026-10-01"].itemOverrides).toBeUndefined();
  });

  it("lets a later clear, swap or authored meal win over an older selection", () => {
    for (const change of [
      { swaps: { "meal-3": "another-meal" } },
      { itemOverrides: { "meal-3": { baseMealId: "recipe:revision",
        components: [], cleared: true } } },
      { itemOverrides: { "meal-3": { baseMealId: "recipe:revision",
        components: [{ name: "Soup", qty: 1, unit: "whole", role: "free",
          macros: { kcal: 200, protein: 10, carbs: 20, fat: 8 } }] } } },
    ]) {
      const original = { date: selection.localDate, ...change };
      const store = { days: { [selection.localDate]: original } } as unknown as Store;
      expect(withAcceptedRecipeSelections(store, [selection]).days[selection.localDate]).toBe(original);
    }
  });

  it("reconciles only the captured old clear; a later local clear keeps precedence", () => {
    const clear = { baseMealId: "old-meal", components: [], cleared: true };
    const accepted = { ...selection, baselineSwap: null, baselineOverride: clear,
      acceptedAt: "2026-10-01T12:00:00Z" };
    const old = { days: { [selection.localDate]: { date: selection.localDate,
      updatedAt: "2026-10-01T11:00:00Z", itemOverrides: { "meal-3": clear } } } } as unknown as Store;
    expect(withAcceptedRecipeSelections(old, [accepted]).days[selection.localDate]
      .itemOverrides?.["meal-3"]?.title).toBe("Stew");
    const unstamped = { days: { [selection.localDate]: { date: selection.localDate,
      itemOverrides: { "meal-3": clear } } } } as unknown as Store;
    expect(withAcceptedRecipeSelections(unstamped, [accepted]).days[selection.localDate]
      .itemOverrides?.["meal-3"]?.title).toBe("Stew");
    const future = { days: { [selection.localDate]: { ...old.days[selection.localDate],
      updatedAt: "2026-10-01T13:00:00Z" } } } as unknown as Store;
    expect(withAcceptedRecipeSelections(future, [accepted]).days[selection.localDate])
      .toBe(future.days[selection.localDate]);
    const changed = { days: { [selection.localDate]: { ...old.days[selection.localDate],
      itemOverrides: { "meal-3": { ...clear, baseMealId: "new-meal" } } } } } as unknown as Store;
    expect(withAcceptedRecipeSelections(changed, [accepted]).days[selection.localDate])
      .toBe(changed.days[selection.localDate]);
  });

  it("distinguishes a captured clear from a new identical clear or swap-clear marker", () => {
    const old = { baseMealId: "old-meal", components: [], cleared: true,
      mutationId: "11111111-1111-4111-8111-111111111111" };
    const accepted = { ...selection, baselineSwap: null, baselineOverride: old,
      acceptedAt: "2026-10-01T12:00:00Z" };
    const oldReplay = { days: { [selection.localDate]: { date: selection.localDate,
      itemOverrides: { "meal-3": old } } } } as unknown as Store;
    expect(withAcceptedRecipeSelections(oldReplay, [accepted]).days[selection.localDate]
      .itemOverrides?.["meal-3"]?.title).toBe("Stew");
    const timeOnly = { days: { [selection.localDate]: { date: selection.localDate,
      updatedAt: "2026-10-01T13:00:00Z",
      itemOverrides: { "meal-3": { ...old, time: "13:15" } } } } } as unknown as Store;
    expect(withAcceptedRecipeSelections(timeOnly, [accepted]).days[selection.localDate]
      .itemOverrides?.["meal-3"]?.title).toBe("Stew");
    const newClear = { days: { [selection.localDate]: { date: selection.localDate,
      itemOverrides: { "meal-3": { ...old,
        mutationId: "22222222-2222-4222-8222-222222222222" } } } } } as unknown as Store;
    expect(withAcceptedRecipeSelections(newClear, [accepted]).days[selection.localDate])
      .toBe(newClear.days[selection.localDate]);
    const swapClear = { days: { [selection.localDate]: { date: selection.localDate,
      itemOverrides: { "meal-3": { baseMealId: null, components: [], followPlan: true,
        mutationId: "33333333-3333-4333-8333-333333333333" } } } } } as unknown as Store;
    expect(withAcceptedRecipeSelections(swapClear, [accepted]).days[selection.localDate])
      .toBe(swapClear.days[selection.localDate]);
  });

  it("keeps the eaten snapshot and refuses to display missing nutrition as zero", () => {
    const eaten = { days: { "2026-10-01": { date: "2026-10-01",
      eaten: { "meal-3": "2026-10-01T18:00:00Z" } } } } as unknown as Store;
    expect(withAcceptedRecipeSelections(eaten, [selection]).days["2026-10-01"])
      .toBe(eaten.days["2026-10-01"]);
    const missing = { ...selection, nutritionSnapshot: { ...selection.nutritionSnapshot,
      protein: { value: null, status: "unknown" as const, sourceRevisionId: null } } };
    expect(withAcceptedRecipeSelections({ days: {} } as unknown as Store, [missing]).days)
      .toEqual({});
  });

  it("renders the selection through Today's resolver with the accepted nutrition", () => {
    const store = defaultStore();
    const projected = withAcceptedRecipeSelections(store, [selection]);
    const slot = resolveDay(projected, selection.localDate).slots
      .find((row) => row.slot === selection.slotId)!;
    expect(slot.meal?.name).toBe("Stew");
    expect(slot.meal?.components).toEqual(slot.components);
    expect(slot.macros).toMatchObject({ kcal: 300, protein: 20, carbs: 40, fat: 8 });
  });

  it("still applies a new verdict over a slot that already carries a projected mark (round 2, finding 8)", () => {
    const baselineOverride = { baseMealId: null, title: "Snack", components: [] };
    const store = { days: { "2026-10-01": { date: "2026-10-01", updatedAt: "2026-09-30T00:00:00Z",
      itemOverrides: { "meal-3": { ...baselineOverride, ruleMark: null, ruleMarkEpoch: 0,
        ruleIngredients: ["Old"] } } } } } as unknown as Store;
    const accepted = { ...selection, acceptedAt: "2026-10-01T00:00:00Z", baselineOverride,
      ruleMark: { verdict: "blocked" as const, reason: "Beans is on your Avoid list." }, ruleMarkEpoch: 7 };
    const projected = withAcceptedRecipeSelections(store, [accepted]).days["2026-10-01"]
      .itemOverrides?.["meal-3"];
    expect(projected?.title).toBe("Stew");
    expect(projected?.ruleMark).toEqual(accepted.ruleMark);
    expect(projected?.ruleMarkEpoch).toBe(7);
    expect(projected?.ruleIngredients).toEqual(["Beans", "Salt"]);
  });
});
