/**
 * The coach's view of the deterministic constraint policy — architecture §4.4.
 *
 * These are thin wrappers over lib/policy/constraints.ts evaluatePolicy. There is exactly one
 * policy implementation in this codebase; a second one would drift from the search badge and the
 * capture flag, and a drifted policy is how a blocked food reaches their plate.
 *
 * Pure. No I/O, no Supabase import.
 */

import type { CoachDraft, CoachSuggestion } from "@/lib/coach/types";
import type { StoredAllergenEvidence } from "@/lib/policy/allergens";
import { evaluatePolicy, type ConstraintProfile, type PolicyEvidence, type PolicyMark } from "@/lib/policy/constraints";

export type Verdict =
  | { verdict: "allowed" } | { verdict: "blocked"; reason: string } | { verdict: "unverified" };

export type PolicyItem = {
  foodRefId: string | null; name: string; grams: number | null;
  allergenTags: string[] | null;
  /** The revision's `policy_categories`, not the provider's own category text. */
  category: string[] | null;
  onEatsList: boolean; onAvoidList: boolean;
  /** Phase 13 §5: stored per-allergen evidence, the user's product checks, the ingredient text. */
  allergenEvidence?: Readonly<Record<string, StoredAllergenEvidence>>;
  checkedAllergens?: readonly string[];
  ingredientsText?: string | null;
  /** sol BLOCK (r5): whether `ingredientsText` is a genuine label, not a custom food's own text. */
  ingredientsTextIsLabel?: boolean;
  /** 2026-10-02: the food's own brand, for lib/policy/whole-foods.ts's whole-food clearance. */
  foodBrand?: string | null;
  /**
   * 2026-10-02 DeepSeek audit (F2, MED): true for a scanned barcode or label lane — packaged by
   * definition, whether or not `foodBrand` above is set on this particular row. `PolicyItem` had
   * no such field at all, so a packaged, unbranded product could still read as a generic whole-food
   * identity by name alone.
   */
  packaged?: boolean;
  /** The catalog revision the id was resolved from, when it was one (the facet cache key). */
  catalogFoodRevisionId?: number | null;
};

/**
 * The allergen facts a hit carries, for checkItem. Absent facts mean no_evidence (unverified).
 * Accepts either a `FoodHit`-shaped source (`brand`) or an already-`PolicyItem`-shaped one
 * (`foodBrand`) — every call site spreads this straight into a policy-evidence object built from
 * one or the other, so one helper covers both (2026-10-02 DeepSeek audit, F2: neither shape's
 * `foodBrand`/`packaged` was reaching evaluatePolicy through any of them).
 */
export function allergenFacts(hit: {
  allergenEvidence?: Readonly<Record<string, StoredAllergenEvidence>>;
  checkedAllergens?: readonly string[]; ingredientsText?: string | null;
  ingredientsTextIsLabel?: boolean;
  brand?: string | null; foodBrand?: string | null; packaged?: boolean;
} | null | undefined): Pick<PolicyItem,
  "allergenEvidence" | "checkedAllergens" | "ingredientsText" | "ingredientsTextIsLabel"
  | "foodBrand" | "packaged"> {
  return { allergenEvidence: hit?.allergenEvidence, checkedAllergens: hit?.checkedAllergens,
    ingredientsText: hit?.ingredientsText ?? null,
    ingredientsTextIsLabel: hit?.ingredientsTextIsLabel,
    foodBrand: hit?.foodBrand ?? hit?.brand ?? null,
    packaged: hit?.packaged };
}

/** Evidence keyed by the food name the model used. A name with no entry has no evidence. */
export type EvidenceByName = Record<string, Omit<PolicyItem, "name" | "grams">>;

function narrow(v: { verdict: "allowed" | "blocked" | "unverified"; reason?: string }): Verdict {
  if (v.verdict === "blocked") return { verdict: "blocked", reason: v.reason ?? "blocked" };
  if (v.verdict === "unverified") return { verdict: "unverified" };
  return { verdict: "allowed" };
}

/**
 * `withProfileRules` opts in to the account's confirmed profile hard rules (Phase 13 §4, §9 R5).
 * The reply check sets it; the suggestion/compose pre-checks leave it off, because they read no
 * facets and a rule with no evidence would read "unknown" for every food — their candidates are
 * judged against the rules afterwards, with cached facets, in filterSuggestionCandidates.
 */
export function checkItem(
  item: PolicyItem, profile: ConstraintProfile, withProfileRules = false,
): Verdict {
  return narrow(evaluatePolicy(profile, itemEvidence(item, profile, withProfileRules)));
}

/**
 * checkItem, plus the marks behind an unverified verdict: the coach card says "Check the label"
 * only when one of them is an allergen gap (sol FIX, t2b review). An empty `preferenceFlags` asks
 * evaluatePolicy for its marks without adding any rule, so the verdict is checkItem's own.
 */
export function checkItemWithMarks(
  item: PolicyItem, profile: ConstraintProfile,
): Verdict & { marks?: PolicyMark[] } {
  const verdict = evaluatePolicy(profile, { ...itemEvidence(item, profile, false), preferenceFlags: [] });
  const narrowed = narrow(verdict);
  return narrowed.verdict === "unverified" ? { ...narrowed, marks: verdict.marks ?? [] } : narrowed;
}

function itemEvidence(
  item: PolicyItem, profile: ConstraintProfile, withProfileRules: boolean,
): PolicyEvidence {
  return {
    ...(withProfileRules ? { profileRules: profile.profileRules } : {}),
    foodRefId: item.foodRefId, allergenTags: item.allergenTags,
    category: item.category, onEatsList: item.onEatsList, onAvoidList: item.onAvoidList,
    allergenEvidence: item.allergenEvidence, checkedAllergens: item.checkedAllergens,
    ingredientsText: item.ingredientsText ?? null,
    ingredientsTextIsLabel: item.ingredientsTextIsLabel,
    // r4 BLOCK #8 (follow-up): checkItem is the one place every coach path (checkDraft/
    // checkReply's reply-check, the suggestion filter) converges on — the food's own name was
    // reaching every OTHER evaluatePolicy call site by round 4 but not this shared one, so
    // "Canned tuna" with "Water, salt." still slipped through checkReply.
    foodName: item.name,
    foodBrand: item.foodBrand,
    packaged: item.packaged,
  };
}

export function checkDraft(
  draft: CoachDraft, profile: ConstraintProfile, evidence: EvidenceByName = {},
  withProfileRules = false,
): CoachSuggestion[] {
  return draft.items.map((row) => {
    // No evidence entry means no ingredient evidence and no Eats entry: unverified, not allowed.
    const e = evidence[row.name] ?? {
      foodRefId: row.foodRefId, allergenTags: null, category: null,
      onEatsList: false, onAvoidList: false,
    };
    const verdict = checkItem(
      { ...e, name: row.name, grams: row.grams, foodRefId: e.foodRefId ?? row.foodRefId }, profile,
      withProfileRules,
    );
    return {
      foodRefId: row.foodRefId, name: row.name, grams: row.grams,
      reason: verdict.verdict === "blocked" ? verdict.reason : null,
      verdict: verdict.verdict,
    };
  });
}
