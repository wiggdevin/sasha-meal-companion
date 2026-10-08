/**
 * Phase 18 W10b (D8's caller table): the shopping planner adds `RECIPE_TASTE_POINTS × (T − 1)`
 * over a candidate's ingredients by grams when the account's quantized taste values are given.
 */
import { describe, expect, it } from "vitest";
import { planShoppingPeriod } from "@/lib/shopping/planner";
import type { TasteValues } from "@/lib/meals/preference";
import { ingredient, recipe } from "../recipes/fixture";
import { identityFor, period } from "./fixture";

const candidate = (partial: Parameters<typeof recipe>[0] = {}) => ({
  ...recipe(partial), eligibility: { status: "eligible" as const, reasons: [] },
});
const known = (value: number) => ({ value, status: "estimated" as const, sourceRevisionId: null });

describe("W10b: the planner's taste term", () => {
  it("ranks the recipe with the higher quantized taste value first, all else equal", () => {
    const slot = { localDate: "2026-10-01", slotId: "meal-3", targetKcal: 500 };
    const beef = candidate({ recipeId: "beef", revisionId: "beef-v1", name: "Beef bowl",
      nutritionPerServing: { kcal: known(500) },
      ingredients: [ingredient({ seq: 1, name: "ground beef" })] });
    const turkey = candidate({ recipeId: "turkey", revisionId: "turkey-v1", name: "Turkey bowl",
      nutritionPerServing: { kcal: known(500) },
      ingredients: [ingredient({ seq: 1, name: "ground turkey" })] });
    const taste: TasteValues = { "ground turkey": { base: 1.5 }, "ground beef": { base: -0.5 } };

    const result = planShoppingPeriod({ period: period(), slots: [slot],
      candidates: [beef, turkey], basket: [], pins: [], aggregate: { identityFor }, taste });
    expect(result.choices[0].candidateRevisionId).toBe("turkey-v1");
  });

  it("adds no term at all when taste is absent (no caller wires this up yet)", () => {
    const slot = { localDate: "2026-10-01", slotId: "meal-3", targetKcal: 500 };
    const beef = candidate({ recipeId: "beef", revisionId: "beef-v1", name: "Beef bowl",
      nutritionPerServing: { kcal: known(500) },
      ingredients: [ingredient({ seq: 1, name: "ground beef" })] });
    const result = planShoppingPeriod({ period: period(), slots: [slot],
      candidates: [beef], basket: [], pins: [], aggregate: { identityFor } });
    expect(result.choices[0].candidateRevisionId).toBe("beef-v1");
  });
});
