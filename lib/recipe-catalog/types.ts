/** Shared wire contract for complete published recipes. Values are revision-pinned. */
export type PublicationState = "draft" | "published" | "withdrawn" | "superseded";
export type EvidenceState = "known" | "estimated" | "unknown";
// Estimated means a numeric, provenance-backed approximation and may support an explicitly
// approximate portion preview. Unknown means the value is missing; never treat it as zero.
export const RECIPE_MACROS = ["kcal", "protein", "carbs", "fat"] as const;
export type RecipeMacroKey = typeof RECIPE_MACROS[number];
export type RecipeEligibility = {
  status: "eligible" | "blocked" | "unknown";
  reasons: { code: string; message: string; ingredientSeq?: number }[];
};
export type RecipeNutrient = {
  value: number | null;
  status: EvidenceState;
  /** Exact food revision or documented original estimate used to obtain this value. */
  sourceRevisionId: number | null;
  /** Bundled USDA SR Legacy row when no catalog revision maps without ambiguity. */
  sourceKey?: string | null;
};
export type RecipeIngredient = {
  seq: number;
  name: string;
  foodRefId: string | null;
  catalogFoodRevisionId: number | null;
  foodDbId?: string | null;
  quantity: number;
  unit: string;
  grams: number | null;
  state: "raw" | "cooked" | "as_purchased";
  required: boolean;
  purchaseGrams: number | null;
  purchaseConversionStatus: EvidenceState;
  nutrition: Record<string, RecipeNutrient>;
  allergenEvidence: Record<string, "present" | "absent" | "unknown">;
  /**
   * The pinned catalog revision's own description, attached where the recipe is read for an
   * account (lib/server/recipe-candidates.ts). Absent when the line pins nothing or the revision
   * could not be read. Display and diet judgement only; never authored or stored.
   */
  catalogFoodName?: string;
};
export type RecipeSource = {
  author: string;
  sourceUrl: string | null;
  rightsKind: "original" | "licensed" | "link_only";
  rightsRecord: string;
  sourceRevision: string;
  kitchenTested: boolean;
};
export type CatalogRecipe = {
  sourceKind: "shared";
  recipeId: string;
  revisionId: string;
  publicationState: PublicationState;
  withdrawalReason: string | null;
  name: string;
  cuisine: string | null;
  dishTags: string[];
  activeMinutes: number | null;
  totalMinutes: number | null;
  effort: "none" | "minimal" | "standard";
  servings: number;
  yieldGrams: number | null;
  yieldStatus: EvidenceState;
  minServingFraction: number;
  maxServingFraction: number;
  ingredients: RecipeIngredient[];
  steps: { seq: number; text: string }[];
  nutritionPerServing: Record<string, RecipeNutrient>;
  source: RecipeSource;
};
export type RecipeCandidate = CatalogRecipe & {
  eligibility: RecipeEligibility;
  /**
   * Set by the planning routes (`GET /api/recipes`, `GET /api/recipes/[id]`): the selection GET's
   * verdict under the CURRENT rules — null clear, else blocked/unknown. Absent when never judged
   * (an older server, server-internal candidates); treat absence as unknown.
   */
  ruleMark?: import("@/lib/types").RuleMark | null;
  /** Phone only: the rules key the planning route judged `ruleMark` under (its `ruleFlags`, or
   *  unjudged); lib/recipes/recipe-freshness.ts compares it with the phone's own. */
  ruleMarkRulesKey?: string;
};
export type RecipeSearch = {
  query: string;
  cuisine?: string;
  maxMinutes?: number;
  effort?: CatalogRecipe["effort"];
  excludedFoodRefIds?: string[];
  limit?: number;
  /**
   * The meal the request named ("easy breakfast"). Ranks recipes whose dish tags name that meal
   * first; never filters (lib/recipes/occasion.ts, Phase 17 O4).
   */
  occasion?: "breakfast" | "lunch" | "dinner" | "snack";
};
