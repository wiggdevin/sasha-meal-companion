/**
 * The fail-closed suggestion verdict (split out of lib/coach/suggest-policy.ts for the file-size
 * cap; suggest-policy re-exports everything here, so callers are unchanged).
 */
import type { ComposedItem } from "@/lib/coach/compose";
import type { SuggestionFoodEvidence } from "@/lib/coach/suggest-evidence-types";
import type { SuggestionEvidence } from "@/lib/coach/suggest-policy";
import { facetOutcome } from "@/lib/policy/facet-rules";
import { evaluatePolicy, type ConstraintProfile, type PolicyEvidence } from "@/lib/policy/constraints";
import { classifyWholeFood } from "@/lib/policy/whole-foods";
import { reasonFragment } from "@/lib/policy/reason-words";

export function suggestionFoodIdentity(item: Pick<ComposedItem,
  "foodRefId" | "catalogFoodRevisionId">): string {
  return `ref:${item.foodRefId}`;
}

export type CandidateOutcome = "allowed" | "blocked" | "unverified" | "requires_preparation";
type PolicyCandidateItem = Pick<ComposedItem,
  "foodRefId" | "catalogFoodRevisionId" | "verdict">;

/** The same fail-closed verdict used by coach suggestions, available to account-owned plans. */
export function suggestionItemsOutcome(
  items: readonly PolicyCandidateItem[],
  evidence: SuggestionEvidence,
  profile: ConstraintProfile,
  needsNoCook: boolean,
): CandidateOutcome {
  return suggestionItemsVerdict(items, evidence, profile, needsNoCook).outcome;
}

/** evaluatePolicy's reason code (`allergen:peanut`, `facet:meat`, `avoid_list`, `rule:x`) in words. */
export function policyReasonWords(reason: string | undefined): string {
  return reasonFragment(reason);
}

/** The outcome with the first reason that decided it, for marks that must say why. */
export function suggestionItemsVerdict(
  items: readonly PolicyCandidateItem[],
  evidence: SuggestionEvidence,
  profile: ConstraintProfile,
  needsNoCook: boolean,
): { outcome: CandidateOutcome; reason?: string } {
  if (evidence.status === "unavailable") {
    return { outcome: "unverified", reason: "could not be checked against your food rules right now." };
  }
  let hasBlocked = false;
  let hasUnverified = false;
  let hasPreparation = false;
  let blockedReason: string | undefined;
  // A rule's own reason (an allergen, a category) is the more useful one to show.
  let humanReason: string | undefined;
  let unverifiedReason: string | undefined;
  for (const item of items) {
    if (item.verdict === "blocked") hasBlocked = true;
    if (item.verdict === "unverified") hasUnverified = true;
    const facts = evidence.byIdentity[suggestionFoodIdentity(item)];
    const human = facetOutcome("human_food", facts?.facets.human_food?.p, "exclude");
    if (human === "absent") {
      hasBlocked = true;
      humanReason ??= "is not recognised as a food.";
    }
    // Live trace 2026-10-02: nothing judges a catalog food on the Eats list, so food_facets held
    // no human_food row for almost any of them and every card was hidden here. A plain whole food
    // (not packaged, not branded, no other ingredients) is human food by its own name, the same
    // name rule the allergen floor already applies to it; a model judgment is needed for the rest.
    if (human === "unknown" && !plainWholeFood(facts)) {
      hasUnverified = true;
      unverifiedReason ??= "has not been confirmed as a food yet.";
    }
    const policy = evaluatePolicy(profile,
      suggestionPolicyEvidence(item.foodRefId, facts, evidence.preferenceFlags, profile));
    if (policy.verdict === "blocked") {
      hasBlocked = true;
      blockedReason ??= policyReasonWords(policy.reason);
    }
    if (policy.verdict === "unverified") {
      hasUnverified = true;
      const unknown = policy.allergens?.filter((finding) => finding.outcome === "unknown")
        .map((finding) => finding.allergen).join(", ");
      unverifiedReason ??= unknown ? `cannot be checked for ${unknown}.`
        : "cannot be checked against your food rules.";
    }
    if (needsNoCook) {
      const prep = preparationOutcome(facts);
      if (prep === "present") hasPreparation = true;
      if (prep === "unknown") hasUnverified = true;
    }
  }
  if (hasBlocked) {
    return { outcome: "blocked", reason: blockedReason ?? humanReason ?? "is excluded by your food rules." };
  }
  if (hasUnverified) {
    return { outcome: "unverified", reason: unverifiedReason ?? "cannot be checked against your food rules." };
  }
  return { outcome: hasPreparation ? "requires_preparation" : "allowed" };
}

/**
 * The one PolicyEvidence a suggestion, an eligible-foods answer and the W2c impact report judge a
 * food on (scripts/diet-rule-jev-impact.ts must see exactly what the app sees).
 */
export function suggestionPolicyEvidence(
  foodRefId: string, facts: SuggestionFoodEvidence | undefined,
  preferenceFlags: SuggestionEvidence["preferenceFlags"], profile: ConstraintProfile,
): PolicyEvidence {
  return {
    foodRefId,
    allergenTags: facts?.allergenTags ?? null,
    allergenEvidence: facts?.allergenEvidence ?? {},
    checkedAllergens: facts?.checkedAllergens ?? [],
    ingredientsText: facts?.ingredientsText ?? null,
    ingredientsTextIsLabel: facts?.ingredientsTextIsLabel,
    foodName: facts?.foodName ?? null,
    foodBrand: facts?.foodBrand ?? null,
    // 2026-10-02 DeepSeek audit (F2, MED): a packaged row never gets whole-food clearance.
    packaged: facts?.packaged,
    category: facts?.policyCategories ?? null,
    onEatsList: facts?.onEatsList === true,
    onAvoidList: facts?.onAvoidList === true,
    preferenceFlags,
    facets: facts?.facets ?? {}, attestedFacets: facts?.attestedFacets,
    facetAction: "exclude",
    profileRules: profile.profileRules,
  };
}

function plainWholeFood(facts: SuggestionFoodEvidence | undefined): boolean {
  return facts !== undefined && classifyWholeFood({
    foodName: facts.foodName ?? null, brand: facts.foodBrand ?? null,
    ingredientsText: facts.ingredientsText ?? null, packaged: facts.packaged,
  }) !== null;
}

function preparationOutcome(facts: SuggestionFoodEvidence | undefined) {
  if (facts?.noCook === true) return "absent" as const;
  if (facts?.noCook === false) return "present" as const;
  return facetOutcome("requires_preparation", facts?.facets.requires_preparation?.p, "exclude");
}
