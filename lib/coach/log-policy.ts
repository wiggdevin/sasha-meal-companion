import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import type { ComposedItem } from "@/lib/coach/compose";
import type { LogItemInput } from "@/lib/log/contract";
import {
  loadSuggestionEvidence,
  suggestionFoodIdentity,
  type SuggestionEvidence,
  type SuggestionEvidencePort,
} from "@/lib/coach/suggest-policy";
import {
  evaluatePolicy,
  unresolvedFacets,
  type ConstraintProfile,
  type PolicyEvidence,
  type PolicyMark,
} from "@/lib/policy/constraints";
import { FACET_RULES, type PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";

export type LogPolicyResult = { actions: CoachAction[]; notices: string[] };
export type LogPolicyOptions = {
  evidence?: SuggestionEvidence;
  evidencePort?: SuggestionEvidencePort;
};

const PREFERENCE_COPY: Record<PolicyPreferenceFlag, string> = {
  vegetarian: "vegetarian", vegan: "vegan", pescatarian: "pescatarian",
  no_pork: "no-pork", no_beef: "no-beef", no_shellfish: "no-shellfish",
  no_eggs: "egg-free", no_soy: "no-soy", no_peanuts: "peanut-free",
  low_fodmap: "low-FODMAP", halal: "halal", kosher: "kosher",
};

/**
 * The whole-account version: every flag the account has at all, with no regard to whether THIS
 * item's own evidence even touches it. Kept only for the evidence-UNAVAILABLE path (below), where
 * there are no per-item marks to read and this is the best that can be said.
 */
function unverifiedNoticeForFlags(name: string, flags: readonly PolicyPreferenceFlag[]): string {
  const labels = flags.map((flag) => PREFERENCE_COPY[flag]);
  const preference = labels.length === 1 ? labels[0] : labels.join(" / ");
  return `Not verified: ${name} (your ${preference} preference${labels.length === 1 ? "" : "s"}).`;
}

/**
 * Which of the account's preference flags THIS item's own marks actually leave open, by the facet
 * each flag watches (lib/policy/facet-rules.ts FACET_RULES) — never the whole account list.
 *
 * 2026-10-02 DeepSeek audit: this used to keep a flag the moment ANY mark on its facet read
 * "unknown", regardless of resolvePolicyVerdict's own rule that a lower-SOURCE_ORDER "absent" mark
 * on the same facet resolves it (lib/policy/constraints.ts unresolvedFacets) — a no_peanuts
 * account with an ingredient-level "absent" (a complete tag list naming no peanut) and only a
 * jev-level "unknown" got blamed in the notice for an unrelated unresolved preference.
 */
function unresolvedPreferenceFlags(
  marks: readonly PolicyMark[], flags: readonly PolicyPreferenceFlag[],
): PolicyPreferenceFlag[] {
  const openFacets = unresolvedFacets(marks);
  return flags.filter((flag) => FACET_RULES[flag].some((rule) => openFacets.has(rule.facet)));
}

/**
 * The named allergens (never the no-evidence catch-all "allergens" facet, never tuna_mercury,
 * which no label check clears) this item's own floor marks leave open — the same test
 * components/coach/editors/not-verified.ts labelCheckNeeded uses to decide "Check the label".
 */
function unresolvedAllergenFacets(marks: readonly PolicyMark[]): string[] {
  return [...new Set(marks
    .filter((mark) => mark.outcome === "unknown" && mark.source === "floor"
      && mark.facet !== "tuna_mercury" && mark.facet !== "allergens")
    .map((mark) => mark.facet))];
}

/**
 * sol FIX (2026-10-01): "Not verified: 2 oz Espresso (your no-pork preference)" and the identical
 * line for Jasmine rice — unverifiedNoticeForFlags used to run on evidence.preferenceFlags, the
 * account's whole preference list, regardless of whether THIS item's own marks even left that
 * preference unresolved. A food unverified for an unrelated allergen gap names that allergen
 * instead, and falls back to a neutral line only when no mark names anything specific.
 */
function unverifiedNotice(
  name: string, marks: readonly PolicyMark[], accountFlags: readonly PolicyPreferenceFlag[],
): string {
  const flags = unresolvedPreferenceFlags(marks, accountFlags);
  if (flags.length > 0) return unverifiedNoticeForFlags(name, flags);
  const allergens = unresolvedAllergenFacets(marks);
  if (allergens.length > 0) return `Not verified: ${name} (check the label for ${allergens.join(", ")}).`;
  return `Not verified: ${name} (allergen details missing).`;
}

/** The log mark for an item judged without its evidence read (lib/server/log.ts reuses it). */
export const RULES_UNREADABLE_MESSAGE = "unverified:food_rules:Your food rules could not be checked.";

export function logCommitPolicyIssues(
  profile: ConstraintProfile,
  items: readonly LogItemInput[],
  baseEvidence: readonly PolicyEvidence[],
  evidence: SuggestionEvidence,
): { path: string; message: string }[] {
  if (evidence.status !== "ready") {
    console.warn("[coach-log-policy] commit evidence unavailable; evaluating without cached facets");
  }
  return items.flatMap((item, index) => {
    const base = baseEvidence[index];
    const facts = evidence.byIdentity[suggestionFoodIdentity({
      foodRefId: item.food_ref_id,
      catalogFoodRevisionId: item.food_revision_id ?? null,
    })];
    const verdict = evaluatePolicy(profile, {
      ...base,
      allergenTags: facts?.allergenTags ?? base.allergenTags,
      allergenEvidence: facts?.allergenEvidence ?? base.allergenEvidence,
      checkedAllergens: facts?.checkedAllergens ?? base.checkedAllergens,
      ingredientsText: facts?.ingredientsText ?? base.ingredientsText,
      ingredientsTextIsLabel: facts?.ingredientsTextIsLabel ?? base.ingredientsTextIsLabel,
      foodName: facts?.foodName ?? base.foodName,
      foodBrand: facts?.foodBrand ?? base.foodBrand,
      // 2026-10-02 DeepSeek audit (F2, MED): same threading as foodBrand above.
      packaged: facts?.packaged ?? base.packaged,
      category: facts?.policyCategories ?? base.category,
      onEatsList: facts?.onEatsList ?? base.onEatsList,
      onAvoidList: facts?.onAvoidList ?? base.onAvoidList,
      preferenceFlags: evidence.status === "ready"
        ? evidence.preferenceFlags : base.preferenceFlags ?? evidence.preferenceFlags,
      facets: evidence.status === "ready" ? facts?.facets ?? {} : {},
      attestedFacets: evidence.status === "ready" ? facts?.attestedFacets : undefined,
      facetAction: "mark",
      // Phase 13 §4, §9 R5 (owner ruling 2026-10-02): the commit path never read the account's
      // confirmed profile hard rules at all — only suggest/compose did. `profile.profileRules` is
      // read once per turn beside the constraint row (lib/server/policy-profile.ts) and travels
      // here on `profile` the same way it already does to markLoggedActions below.
      profileRules: profile.profileRules,
    });
    if (verdict.verdict === "blocked") {
      return [{ path: `items.${index}`, message: `blocked:${verdict.reason}` }];
    }
    // Phase 18 W2a (review r1 BLOCK 2): without the evidence read, this item's stored allergen
    // evidence (a hold included) was never seen, so an `allowed` or a short list of marks here
    // proves nothing. Every non-blocked item carries the rules-unreadable mark on top.
    const unreadable = evidence.status === "ready" ? [] : [{ path: `items.${index}`,
      message: RULES_UNREADABLE_MESSAGE }];
    // sol FIX (review round 2): §5's UX requirement is explicit regardless of which path logged
    // the food — "no_evidence is unverified and shows a 'Check the label' mark" — but this only
    // ever reported `blocked` verdicts, so a food with (e.g.) no peanut evidence committed
    // through this path with no returned mark at all, contrary to that requirement. One issue per
    // allergen a label check would actually resolve (`checkable`).
    //
    // bug repro (round 13, item 4): a noncheckable unverified finding — the pregnancy/tuna check
    // (lib/policy/pregnancy-tuna.ts), `checkable: false` by nature since no label check resolves
    // it — used to be dropped by the `finding.checkable` filter above, so committing a log entry
    // for an unspecified-tuna food gave back no mark at all. It still cannot be checked off, so it
    // carries its own text rather than the generic `allergen:<key>` shape a checkable mark uses.
    if (verdict.verdict === "unverified") {
      const allergenIssues = (verdict.allergens ?? [])
        .filter((finding) => finding.outcome === "unknown")
        .map((finding) => ({
          path: `items.${index}`,
          message: finding.checkable
            ? `unverified:allergen:${finding.allergen}`
            : `unverified:${finding.allergen}:${finding.text}`,
        }));
      // 2026-10-02 owner ruling: a confirmed profile hard rule with no evidence yet resolves
      // "unknown" the same way an allergen with no evidence does, but only allergen findings ever
      // reached the commit's own `flagged` issues — a profile rule could sit unresolved with
      // nothing telling the user to check it.
      const profileRuleIssues = (verdict.marks ?? [])
        .filter((mark) => mark.source === "profile" && mark.outcome === "unknown")
        // The facet as words: the user reads the last segment ("a label check for dairy").
        .map((mark) => ({ path: `items.${index}`,
          message: `unverified:profile_rule:${mark.facet.replace(/^contains_/, "").replaceAll("_", " ")}` }));
      return [...allergenIssues, ...profileRuleIssues, ...unreadable];
    }
    return unreadable;
  });
}

function asComposedItem(item: GroundedActionItem): ComposedItem {
  return { ...item, macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } };
}

/** Logging never refuses a food; cached preference evidence only marks the persisted action. */
export async function markLoggedActions(
  userId: string,
  actions: readonly CoachAction[],
  profile: ConstraintProfile,
  options: LogPolicyOptions = {},
): Promise<LogPolicyResult> {
  const logs = actions.filter((action) => action.kind === "log_meal");
  if (logs.length === 0) return { actions: [...actions], notices: [] };
  const items = logs.flatMap((action) => action.items.map(asComposedItem));
  const evidence = options.evidence ?? await (options.evidencePort ?? loadSuggestionEvidence)(
    userId, items, { needsNoCook: false, facets: profileRuleFacets(profile.profileRules) },
  );
  const notices: string[] = [];
  if (evidence.status === "unavailable") {
    // Owner ruling (2026-10-02): fail safe. The real loader's unavailable() always answers
    // preferenceFlags: [] (lib/coach/suggest-policy.ts), so "no active preferences" and "the read
    // failed" are the same shape here — there used to be an early return on an empty list that
    // therefore never fired in production. Every non-blocked item is marked unverified instead,
    // with a flags-specific notice when the account's own preferences are known, or a generic
    // one when nothing could be read at all.
    console.warn("[coach-log-policy] evidence unavailable; marking logs unverified");
    const marked = actions.map((action): CoachAction => {
      if (action.kind !== "log_meal") return action;
      const nextItems = action.items.map((item) => {
        if (item.verdict === "blocked") return item;
        notices.push(evidence.preferenceFlags.length > 0
          ? unverifiedNoticeForFlags(item.name, evidence.preferenceFlags)
          : `Not verified: ${item.name} (your food rules could not be checked).`);
        return { ...item, verdict: "unverified" as const };
      });
      return {
        ...action,
        items: nextItems,
        flagged: nextItems.filter((item) => item.verdict === "blocked").map((item) => item.name),
      };
    });
    return { actions: marked, notices: [...new Set(notices)] };
  }

  const marked = actions.map((action): CoachAction => {
    if (action.kind !== "log_meal") return action;
    const nextItems = action.items.map((item) => {
      const facts = evidence.byIdentity[suggestionFoodIdentity(item)];
      const policy = evaluatePolicy(profile, {
        foodRefId: item.foodRefId,
        allergenTags: facts?.allergenTags ?? null,
        allergenEvidence: facts?.allergenEvidence ?? {},
        checkedAllergens: facts?.checkedAllergens ?? [],
        ingredientsText: facts?.ingredientsText ?? null,
        ingredientsTextIsLabel: facts?.ingredientsTextIsLabel,
        foodName: facts?.foodName ?? item.name,
        foodBrand: facts?.foodBrand ?? null,
        // 2026-10-02 DeepSeek audit (F2, MED): same threading as foodBrand above.
        packaged: facts?.packaged,
        category: facts?.policyCategories ?? null,
        onEatsList: facts?.onEatsList === true,
        onAvoidList: facts?.onAvoidList === true,
        preferenceFlags: evidence.preferenceFlags,
        facets: facts?.facets ?? {}, attestedFacets: facts?.attestedFacets,
        facetAction: "mark",
        profileRules: profile.profileRules,
      });
      const verdict = item.verdict === "blocked" ? "blocked" : policy.verdict;
      if (verdict === "blocked") notices.push(`Off-plan: ${item.name}.`);
      if (verdict === "unverified" && evidence.preferenceFlags.length > 0) {
        notices.push(unverifiedNotice(item.name, policy.marks ?? [], evidence.preferenceFlags));
      }
      // The marks travel with an unverified item, so the card says "Check the label" only for
      // an allergen gap, never for a preference or profile rule it cannot resolve (sol FIX, t2b).
      return verdict === "unverified" ? { ...item, verdict, marks: policy.marks ?? [] }
        : { ...item, verdict };
    });
    return {
      ...action,
      items: nextItems,
      flagged: nextItems.filter((item) => item.verdict === "blocked").map((item) => item.name),
    };
  });
  return { actions: marked, notices: [...new Set(notices)] };
}
