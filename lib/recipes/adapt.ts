import type { CatalogRecipe, RecipeCandidate, RecipeNutrient } from "@/lib/recipe-catalog/types";
import { hasCanonicalIngredientIdentity } from "@/lib/recipes/eligibility";
import { dbFood } from "@/lib/food-db";
import { proteinShortfallFit } from "@/lib/meals/size";

export const FIT_MACROS = ["kcal", "protein", "carbs", "fat"] as const;
export type AdaptationIssue = { code: string; message: string; ingredientSeq?: number };
export type AdaptedLine = {
  seq: number; name: string; foodRefId: string | null; foodDbId: string | null; foodRevisionId: number | null;
  quantity: number; unit: string; grams: number | null; purchaseGrams: number | null;
  state: CatalogRecipe["ingredients"][number]["state"];
  /** Immutable line evidence, including bundled FoodDB source keys. */
  nutritionEvidence?: Record<string, RecipeNutrient>;
};
export type Adaptation = {
  parentRevisionId: string;
  servingFraction: number;
  lines: AdaptedLine[];
  nutrition: Record<string, RecipeNutrient>;
  /** True only when all four macros have known, revision-bound, retained line evidence. */
  exactFitAvailable: boolean;
  /** Sourced numeric macros permit a bounded estimate, even when yield or retention is unknown. */
  approximateFitAvailable: boolean;
  issues: AdaptationIssue[];
};
export type AdaptationEvidence = {
  /** Per-line retained fraction; 1 means all nutrients stay in the served dish. */
  retainedFractionBySeq: Readonly<Record<number, number>>;
};

const round = (value: number) => Math.round(value * 10_000) / 10_000;

const clampFraction = (recipe: CatalogRecipe | RecipeCandidate, value: number) =>
  Math.max(recipe.minServingFraction, Math.min(round(value), recipe.maxServingFraction));

const usableTarget = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** A known per-serving value, or null when the evidence is unknown. */
function servingValue(nutrient: RecipeNutrient | undefined): number | null {
  return !nutrient || nutrient.status === "unknown" || nutrient.value === null
    || !Number.isFinite(nutrient.value) ? null : nutrient.value;
}

/**
 * How one serving fraction fits a slot (calculation audit S3): calories AND protein, so a
 * protein-poor recipe at the right kcal does not read as a fit. `kcalFit` is 1 at the target and
 * falls as exp(-error / 0.08), the plate curve; `proteinFit` is lib/meals/size.ts's shortfall penalty
 * (3 % dead zone, never softened by a surplus), 1 with no protein target, 0 when the recipe's
 * protein is unknown. `proteinGapGrams` is served protein minus the target (negative is short);
 * null with no target or unknown protein.
 */
export type ServingFit = { kcalFit: number; proteinFit: number; proteinGapGrams: number | null };

export function recipeServingFit(recipe: CatalogRecipe | RecipeCandidate, fraction: number,
  targetKcal: number | null, targetProtein?: number | null): ServingFit {
  const kcal = servingValue(recipe.nutritionPerServing.kcal);
  const protein = servingValue(recipe.nutritionPerServing.protein);
  // The plate's calorie curve (lib/meals/size.ts shapeFit): as sharp as the protein penalty, which
  // is what makes the kcal-matching fraction the best one (see suggestedServingFraction).
  const kcalFit = usableTarget(targetKcal) && kcal !== null
    ? Math.exp(-Math.abs(kcal * fraction - targetKcal) / targetKcal / 0.08) : 0;
  if (!usableTarget(targetProtein)) return { kcalFit, proteinFit: 1, proteinGapGrams: null };
  if (protein === null) return { kcalFit, proteinFit: 0, proteinGapGrams: null };
  const served = protein * fraction;
  return { kcalFit, proteinFit: proteinShortfallFit(served, targetProtein),
    proteinGapGrams: Math.round((served - targetProtein) * 10) / 10 };
}

/**
 * A bounded, ratio-preserving kcal proposal. The preview still shows every macro gap.
 *
 * It needs no protein term of its own (audit S3): scaling one recipe moves its kcal and protein
 * in proportion, so with the calorie and protein-shortfall penalties equally sharp (0.08, as in
 * lib/meals/size.ts) the kcal-matching fraction already maximises their product — a step up
 * gains protein fit only as fast as it loses calorie fit when protein is short. Protein decides
 * between recipes instead: `recipeServingFit` scores and reports the gap at this fraction.
 */
export function suggestedServingFraction(recipe: CatalogRecipe | RecipeCandidate,
  targetKcal: number | null): number {
  const kcal = servingValue(recipe.nutritionPerServing.kcal);
  if (!usableTarget(targetKcal) || kcal === null || kcal <= 0) {
    return Math.max(recipe.minServingFraction, Math.min(1, recipe.maxServingFraction));
  }
  return clampFraction(recipe, targetKcal / kcal);
}

/** Portion-first adaptation: every ingredient has the same ratio, including spices and binders. */
export function adaptRecipeServing(
  recipe: CatalogRecipe | RecipeCandidate, fraction: number, evidence: AdaptationEvidence,
): Adaptation {
  if (recipe.publicationState !== "published") throw new Error("Recipe revision is unavailable");
  if (!Number.isFinite(fraction) || fraction < recipe.minServingFraction
    || fraction > recipe.maxServingFraction || fraction <= 0) {
    throw new RangeError("Serving fraction is outside this recipe's practical range");
  }
  if (!(recipe.servings > 0)) throw new RangeError("Recipe servings must be positive");
  const batchFraction = fraction / recipe.servings;
  const issues: AdaptationIssue[] = [];
  const lines = recipe.ingredients.map((ingredient) => {
    if (!(ingredient.quantity > 0) || !ingredient.unit.trim()) {
      issues.push({ code: "ingredient_quantity", message: `${ingredient.name} has no usable quantity.`, ingredientSeq: ingredient.seq });
    }
    if (!hasCanonicalIngredientIdentity(ingredient)) {
      issues.push({ code: "food_identity", message: `${ingredient.name} lacks a canonical food identity.`, ingredientSeq: ingredient.seq });
    }
    if (ingredient.grams === null || !(ingredient.grams > 0)) {
      issues.push({ code: "mass_unknown", message: `${ingredient.name} has no measured mass.`, ingredientSeq: ingredient.seq });
    }
    if (ingredient.purchaseConversionStatus !== "known" || ingredient.purchaseGrams === null) {
      issues.push({ code: "purchase_conversion", message: `Raw purchase amount for ${ingredient.name} is not known.`, ingredientSeq: ingredient.seq });
    }
    return {
      seq: ingredient.seq, name: ingredient.name,
      foodRefId: ingredient.foodRefId, foodDbId: ingredient.foodDbId ?? null,
      foodRevisionId: ingredient.catalogFoodRevisionId,
      quantity: round(ingredient.quantity * batchFraction), unit: ingredient.unit,
      grams: ingredient.grams === null ? null : round(ingredient.grams * batchFraction),
      purchaseGrams: ingredient.purchaseGrams === null ? null : round(ingredient.purchaseGrams * batchFraction),
      state: ingredient.state, nutritionEvidence: ingredient.nutrition,
    };
  });
  if (recipe.yieldStatus !== "known" || recipe.yieldGrams === null) {
    issues.push({ code: "yield_unknown", message: "The finished yield is not measured." });
  }
  const nutrition: Record<string, RecipeNutrient> = {};
  const codes = new Set(recipe.ingredients.flatMap((ingredient) => Object.keys(ingredient.nutrition)));
  for (const code of FIT_MACROS) codes.add(code);
  for (const code of codes) {
    let total = 0;
    let status: RecipeNutrient["status"] = "known";
    for (const ingredient of recipe.ingredients) {
      const nutrient = ingredient.nutrition[code];
      const retained = evidence.retainedFractionBySeq[ingredient.seq];
      const retentionKnown = retained !== undefined && Number.isFinite(retained)
        && retained >= 0 && retained <= 1;
      if (!retentionKnown) {
        if (status === "known") status = "estimated";
        issues.push({ code: "retention_unknown", message: `Retained amount for ${ingredient.name} is unknown.`, ingredientSeq: ingredient.seq });
      }
      const pinnedRevision = ingredient.foodRefId && ingredient.catalogFoodRevisionId !== null
        && nutrient?.sourceRevisionId === ingredient.catalogFoodRevisionId;
      const bundledSource = ingredient.foodDbId && dbFood(ingredient.foodDbId)
        && nutrient?.status === "estimated"
        && nutrient.sourceKey === `food-db:${ingredient.foodDbId}`;
      if (!nutrient || nutrient.value === null || !Number.isFinite(nutrient.value)
        || nutrient.status === "unknown" || (!pinnedRevision && !bundledSource)) {
        status = "unknown";
        issues.push({ code: "nutrition_unknown", message: `${code} evidence for ${ingredient.name} is incomplete.`, ingredientSeq: ingredient.seq });
      } else if (nutrient.status === "estimated" && status === "known") {
        status = "estimated";
      }
      if (nutrient?.value !== null && nutrient?.value !== undefined && Number.isFinite(nutrient.value)) {
        // Unknown retention uses the authored line total as a conservative, labeled estimate.
        total += nutrient.value * (retentionKnown ? retained : 1) * batchFraction;
      }
    }
    nutrition[code] = {
      value: status === "unknown" ? null : round(total), status,
      sourceRevisionId: null, // the total has several pinned source revisions; lines hold them.
    };
  }
  const exactFitAvailable = issues.length === 0
    && FIT_MACROS.every((code) => nutrition[code].status === "known");
  const approximateFitAvailable = lines.every((line) => line.quantity > 0)
    && !issues.some((issue) => issue.code === "food_identity" || issue.code === "mass_unknown")
    && FIT_MACROS.every((code) => nutrition[code].value !== null);
  return { parentRevisionId: recipe.revisionId, servingFraction: fraction, lines, nutrition,
    exactFitAvailable, approximateFitAvailable, issues };
}

/** A side or variant must be another complete published revision, not an ingredient patch. */
export function reviewedCompanionOptions(
  candidates: readonly RecipeCandidate[], excludedRevisionId: string,
): RecipeCandidate[] {
  return candidates.filter((candidate) => candidate.revisionId !== excludedRevisionId
    && candidate.publicationState === "published" && candidate.eligibility.status === "eligible"
    && candidate.ingredients.length > 0 && candidate.steps.length > 0);
}
