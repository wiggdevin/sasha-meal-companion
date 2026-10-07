import type { CatalogRecipe } from "@/lib/recipe-catalog/types";
import type { ConstraintProfile, PolicyEvidence } from "@/lib/policy/constraints";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import type { TargetRevision } from "@/lib/types";
import { adaptRecipeServing, type Adaptation, type AdaptationEvidence } from "@/lib/recipes/adapt";
import { recipeEligibility } from "@/lib/recipes/eligibility";

export type PlanRecipeRequest = {
  userId: string;
  localDate: string;
  slotId: string;
  recipeId: string;
  recipeRevisionId: string;
  servingFraction: number;
  /** Explicit confirmation after showing unknown nutrition/yield/purchase evidence. */
  acceptApproximate: boolean;
  expectedTargetRevision: number;
  expectedRulesRevision: string;
  expectedPlanRevision: number;
  idempotencyKey: string;
};
export type PlanRecipeSelection = Readonly<{
  userId: string; localDate: string; slotId: string;
  recipeId: string; recipeRevisionId: string;
  targetRevisionId: string; targetRevision: number; rulesRevision: string;
  planRevision: number; idempotencyKey: string; requestFingerprint: string;
  servingFraction: number; ingredientSnapshot: Adaptation["lines"];
  nutritionSnapshot: Adaptation["nutrition"];
  exactFitAvailable: boolean; approximateFitAvailable: boolean;
  evidenceIssues: Adaptation["issues"];
}>;
export type CurrentPlanAuthority = {
  recipe: CatalogRecipe;
  target: TargetRevision;
  rulesRevision: string;
  profile: ConstraintProfile;
  evidenceBySeq: Readonly<Record<number, Partial<PolicyEvidence>>>;
  explicitAvoidFoodRefIds: readonly string[];
  explicitAvoidFoodDbIds?: readonly string[];
  explicitAvoidNames?: readonly string[];
  preferenceFlags: readonly PolicyPreferenceFlag[];
  adaptationEvidence: AdaptationEvidence;
};
export type PlanCommitPort = {
  /** Must scope lookup by userId and key. */
  findByIdempotencyKey: (userId: string, key: string) => Promise<PlanRecipeSelection | null>;
  /** Reads the current server target and account policy, never the phone display cache. */
  loadCurrent: (userId: string, recipeId: string, revisionId: string) => Promise<CurrentPlanAuthority>;
  /** Atomic CAS: assert plan, target, rules, and recipe publication still match before saving. */
  saveIfCurrent: (selection: PlanRecipeSelection, expected: PlanRecipeRequest) => Promise<PlanRecipeSelection>;
};

function fingerprint(request: PlanRecipeRequest): string {
  return JSON.stringify([request.userId, request.localDate, request.slotId, request.recipeId,
    request.recipeRevisionId, request.servingFraction, request.acceptApproximate,
    request.expectedTargetRevision,
    request.expectedRulesRevision, request.expectedPlanRevision]);
}

/** Revalidate a draft at the server boundary, then atomically pin the exact immutable snapshot. */
export async function commitRecipeToPlan(
  request: PlanRecipeRequest, port: PlanCommitPort,
): Promise<PlanRecipeSelection> {
  if (!request.userId || !request.idempotencyKey || !request.slotId
    || !/^\d{4}-\d{2}-\d{2}$/.test(request.localDate)) {
    throw new Error("Invalid plan selection identity");
  }
  const requestFingerprint = fingerprint(request);
  const prior = await port.findByIdempotencyKey(request.userId, request.idempotencyKey);
  if (prior) {
    if (prior.requestFingerprint !== requestFingerprint) throw new Error("Idempotency key conflict");
    return prior;
  }
  const current = await port.loadCurrent(request.userId, request.recipeId, request.recipeRevisionId);
  if (current.recipe.recipeId !== request.recipeId
    || current.recipe.revisionId !== request.recipeRevisionId
    || current.recipe.publicationState !== "published") {
    throw new Error("Recipe revision changed or was withdrawn; refresh the preview");
  }
  if (current.target.revision !== request.expectedTargetRevision || !current.target.id) {
    throw new Error("Target revision changed; refresh the preview");
  }
  if (current.rulesRevision !== request.expectedRulesRevision) {
    throw new Error("Food rules changed; refresh the preview");
  }
  const eligibility = recipeEligibility(current.recipe, {
    profile: current.profile, evidenceBySeq: current.evidenceBySeq,
    explicitAvoidFoodRefIds: current.explicitAvoidFoodRefIds,
    explicitAvoidFoodDbIds: current.explicitAvoidFoodDbIds,
    explicitAvoidNames: current.explicitAvoidNames,
    preferenceFlags: current.preferenceFlags,
  });
  if (eligibility.status !== "eligible") {
    throw new Error(`Recipe is no longer eligible: ${eligibility.reasons[0]?.message ?? eligibility.status}`);
  }
  const adaptation = adaptRecipeServing(current.recipe, request.servingFraction,
    current.adaptationEvidence);
  if (!adaptation.exactFitAvailable && !request.acceptApproximate) {
    throw new Error("Recipe evidence is incomplete; review the approximate plan before saving");
  }
  if (adaptation.lines.some((line) => line.quantity <= 0
    || (line.foodRevisionId === null && line.foodDbId === null))) {
    throw new Error("Recipe quantity or ingredient identity cannot be pinned");
  }
  const selection: PlanRecipeSelection = {
    userId: request.userId, localDate: request.localDate, slotId: request.slotId,
    recipeId: request.recipeId, recipeRevisionId: request.recipeRevisionId,
    targetRevisionId: current.target.id, targetRevision: current.target.revision,
    rulesRevision: current.rulesRevision, planRevision: request.expectedPlanRevision + 1,
    idempotencyKey: request.idempotencyKey, requestFingerprint,
    servingFraction: request.servingFraction,
    ingredientSnapshot: adaptation.lines.map((line) => ({ ...line })),
    nutritionSnapshot: Object.fromEntries(Object.entries(adaptation.nutrition)
      .map(([key, value]) => [key, { ...value }])),
    exactFitAvailable: adaptation.exactFitAvailable,
    approximateFitAvailable: adaptation.approximateFitAvailable,
    evidenceIssues: adaptation.issues.map((issue) => ({ ...issue })),
  };
  // The port owns the database transaction: a read-only preflight alone cannot close the race.
  return port.saveIfCurrent(selection, request);
}
