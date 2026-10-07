import type { CatalogRecipe, RecipeIngredient, RecipeNutrient } from "@/lib/recipe-catalog/types";

const known = (value: number, sourceRevisionId: number): RecipeNutrient =>
  ({ value, status: "known", sourceRevisionId });

export function ingredient(partial: Partial<RecipeIngredient> & Pick<RecipeIngredient, "seq" | "name">): RecipeIngredient {
  const { seq, name, ...rest } = partial;
  const id = partial.catalogFoodRevisionId ?? seq;
  return {
    seq, name, foodRefId: partial.foodRefId ?? name.toLowerCase(),
    catalogFoodRevisionId: id, quantity: 100, unit: "g", grams: 100,
    state: "raw", required: true, purchaseGrams: 100,
    purchaseConversionStatus: "known", allergenEvidence: {},
    nutrition: { kcal: known(100, id), protein: known(10, id),
      carbs: known(10, id), fat: known(2, id) },
    ...rest,
  };
}

export function recipe(partial: Partial<CatalogRecipe> = {}): CatalogRecipe {
  return {
    sourceKind: "shared", recipeId: "stew", revisionId: "stew-v1",
    publicationState: "published", withdrawalReason: null,
    name: "Bean stew", cuisine: "Mediterranean", dishTags: ["stew"],
    activeMinutes: 15, totalMinutes: 40, effort: "standard",
    servings: 2, yieldGrams: 180, yieldStatus: "known",
    minServingFraction: 0.5, maxServingFraction: 2,
    ingredients: [ingredient({ seq: 1, name: "beans" }), ingredient({ seq: 2, name: "salt" })],
    steps: [{ seq: 1, text: "Simmer the beans with salt." }],
    nutritionPerServing: { kcal: known(100, 1), protein: known(10, 1) },
    source: { author: "Sasha", sourceUrl: null, rightsKind: "original",
      rightsRecord: "original-1", sourceRevision: "1", kitchenTested: false },
    ...partial,
  };
}
