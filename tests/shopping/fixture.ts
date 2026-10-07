import type { IngredientIdentity, ShoppingPeriod } from "@/lib/shopping/types";
import type { RecipeIngredient } from "@/lib/recipe-catalog/types";

export const period = (partial: Partial<ShoppingPeriod> = {}): ShoppingPeriod => ({
  id: "period-1", userId: "account-a", startDate: "2026-10-01", endDate: "2026-10-07",
  timezone: "America/Denver", people: 1, mealCoverage: ["dinner"],
  mode: "balanced", effort: "standard", maxActiveMinutes: null,
  variety: "repeat_friendly", budgetAmount: null, currency: "USD", locale: "US-CO",
  lockMode: "none", planRevision: 0, revision: 0, ...partial,
});

export const identity = (foodRefId: string, variantKey = "plain"): IngredientIdentity => ({
  foodRefId, catalogFoodRevisionId: 1, purchaseState: "raw", variantKey,
});

export const identityFor = (ingredient: RecipeIngredient): IngredientIdentity | null =>
  ingredient.foodRefId ? identity(ingredient.foodRefId)
    : ingredient.foodDbId ? { foodRefId: null, foodDbId: ingredient.foodDbId,
      catalogFoodRevisionId: null, purchaseState: ingredient.state, variantKey: "plain" }
      : null;
