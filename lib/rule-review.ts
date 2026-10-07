/** The prior backfill started at 05:36 UTC; this later cutoff errs toward review. */
export const HISTORICAL_RULE_CUTOFF = "2026-09-21T05:40:00.000Z";

const CANDIDATE_ALLERGENS = ["gluten", "dairy", "apple"] as const;
const CANDIDATE_CATEGORIES = [
  "raw_cruciferous", "raw_leafy_greens", "onion_garlic", "beans", "simple_sugars",
] as const;

export type RuleLists = { avoid_allergens: string[]; banned_categories: string[] };
export type RuleReviewStatus = {
  required: boolean;
  candidateAllergens: string[];
  candidateCategories: string[];
};
export type RuleChoice = "keep" | "remove";
export type RuleChoices = {
  allergens: Record<string, RuleChoice>;
  categories: Record<string, RuleChoice>;
};

/** Never infer a user's intent from the old backfill or from updated_at. */
export function reviewStatus(
  reviewRequired: boolean, reviewedAt: string | null, rules: RuleLists,
): RuleReviewStatus {
  if (!reviewRequired || reviewedAt !== null) {
    return { required: false, candidateAllergens: [], candidateCategories: [] };
  }
  const candidateAllergens = CANDIDATE_ALLERGENS.filter((key) =>
    rules.avoid_allergens.includes(key));
  const candidateCategories = CANDIDATE_CATEGORIES.filter((key) =>
    rules.banned_categories.includes(key));
  // Keep the marker authoritative if a direct data edit emptied the arrays after migration.
  return { required: true,
    candidateAllergens, candidateCategories };
}

/** Every candidate needs an explicit Keep or Remove; unrelated rules are retained verbatim. */
export function applyRuleChoices(
  rules: RuleLists, status: RuleReviewStatus, choices: RuleChoices,
): RuleLists {
  if (!status.required) throw new Error("No rule review is pending.");
  for (const [keys, answers] of [
    [status.candidateAllergens, choices.allergens],
    [status.candidateCategories, choices.categories],
  ] as const) {
    if (Object.keys(answers).length !== keys.length || keys.some((key) =>
      answers[key] !== "keep" && answers[key] !== "remove")) {
      throw new Error("Choose Keep or Remove for every rule.");
    }
  }
  return {
    avoid_allergens: rules.avoid_allergens.filter((key) => choices.allergens[key] !== "remove"),
    banned_categories: rules.banned_categories.filter((key) => choices.categories[key] !== "remove"),
  };
}
