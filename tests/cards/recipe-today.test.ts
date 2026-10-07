import { expect, it } from "vitest";
import { defaultStore } from "@/lib/store";
import { withAcceptedRecipeSelections } from "@/lib/recipes/accepted-overlay";
import { clearMeal } from "@/lib/today/meal-actions";
import { resolveDay } from "@/lib/resolve";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { Store } from "@/lib/types";

const date = "2026-10-08";
const selection = { id: "accepted", localDate: date, slotId: "meal-3", recipeId: "recipe",
  recipeRevisionId: "recipe-v1", recipeName: "Stew", servingFraction: 1,
  nutritionSnapshot: Object.fromEntries(Object.entries({ kcal: 300, protein: 20, carbs: 40, fat: 8 })
    .map(([key, value]) => [key, { value, status: "estimated", sourceRevisionId: null }])),
  ingredientSnapshot: [], exactFitAvailable: false, approximateFitAvailable: true,
  evidenceIssues: [], planRevision: 1 } as AcceptedRecipeSelection;
function shown(store: Store) {
  return resolveDay(withAcceptedRecipeSelections(store, [selection]), date).slots
    .find((slot) => slot.slot === "meal-3")?.meal?.name;
}

it("keeps a later clear, swap and eaten snapshot ahead of the accepted card, then restores it on undo", () => {
  const store = defaultStore();
  expect(shown(store)).toBe("Stew");
  const cleared = { ...store, days: { ...store.days, [date]: { date,
    itemOverrides: { "meal-3": clearMeal(undefined, "recipe:recipe-v1") } } } } as Store;
  expect(shown(cleared)).not.toBe("Stew");
  const undone = { ...cleared, days: { ...cleared.days, [date]: { date } } } as Store;
  expect(shown(undone)).toBe("Stew");
  const swapped = { ...store, days: { ...store.days, [date]: { date,
    swaps: { "meal-3": "another-meal" } } } } as Store;
  expect(shown(swapped)).not.toBe("Stew");
  const eaten = { ...store, days: { ...store.days, [date]: { date,
    eaten: { "meal-3": "2026-10-08T18:00:00Z" },
    itemOverrides: { "meal-3": { baseMealId: "recipe:recipe-v1", title: "Stew",
      components: [{ name: "Stew", qty: 1, unit: "whole", role: "free",
        macros: { kcal: 300, protein: 20, carbs: 40, fat: 8 } }] } },
  } } } as Store;
  expect(shown(eaten)).toBe("Stew");
});
