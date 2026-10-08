/**
 * Deterministic constraint policy — architecture.md §4.4, contracts §4.
 *
 * Runs server-side after every model output and on every search result, recipe save and coach
 * suggestion, so it has no I/O of its own: callers read `constraint_profiles` for `auth.uid()`
 * and pass the row through `loadProfile`.
 *
 * Pure. No I/O, no Supabase import.
 */

import type { FoodFacetJudgments } from "@/lib/foods/facets";
import type { NutrientCode } from "@/lib/nutrients/codes";
import { ingredientRuleMatches, isCustomRule, mayHaveSubingredients, parseCustomRules, type CustomRule } from "@/lib/policy/custom-rules";
import {
  allergenFinding, allergenKey, withCrustaceanAllowance, type AllergenFinding,
  type StoredAllergenEvidence,
} from "@/lib/policy/allergens";
import { pregnancyTunaFinding } from "@/lib/policy/pregnancy-tuna";
import type { FacetOutcome, FacetPolicyAction, PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import type { DietEvidence } from "@/lib/policy/diet-evidence";
import { preferenceMarks } from "@/lib/policy/preference-marks";
import {
  activeConfirmedHardMarks, type ProfileRuleSet,
} from "@/lib/policy/profiles/hard-rules";
import { nameCategories } from "@/lib/policy/whole-foods";

export type ConstraintProfile = {
  avoid_allergens: string[];
  avoid_food_ref_ids: string[];
  banned_categories: string[];
  custom_rules?: readonly CustomRule[];
  /**
   * Free-text self-reported conditions (constraint_profiles.conditions). Optional and additive:
   * §9 R1's pregnancy/tuna check (lib/policy/pregnancy-tuna.ts) is the only thing that reads it
   * so far — a diagnosis otherwise never activates a rule (§4, CONDITION_RULES stays empty).
   */
  conditions?: readonly string[];
  /**
   * The account's dietary-profile ids, where the caller read them with the row
   * (lib/server/policy-profile.ts). Read only by the pregnancy tuna check: the `pregnancy`
   * profile arms it as the free text does (onboarding v2 G7).
   */
  profileIds?: readonly string[];
  /**
   * Phase 13 §4, §9 R5: this account's confirmed dietary-profile hard rules, read once per turn
   * beside the constraint row (lib/server/policy-profile.ts). Carried here so it travels with the
   * profile to every coach call site, but `evaluatePolicy` reads only `PolicyEvidence.profileRules`:
   * a caller opts in where it has the facet evidence to judge them (a rule with no evidence is
   * "unknown", which would hide every food from a pre-check that never reads facets).
   */
  profileRules?: ProfileRuleSet;
};

/**
 * What an account restricts before it has said anything: nothing (D1 §6.1, PRD R2).
 *
 * This constant used to carry gluten, dairy, apple and five banned categories — one person's
 * clinical rules, applied in memory to every account with no `constraint_profiles` row. Those
 * rules now live only in that account's row; `20261026090100_neutral_user_defaults.sql` put them
 * there before this constant lost them, so nobody's restriction was dropped.
 */
export const EMPTY_PROFILE: ConstraintProfile = {
  avoid_allergens: [],
  avoid_food_ref_ids: [],
  banned_categories: [],
};

export type PolicyEvidence = {
  foodRefId: string | null;
  allergenTags: string[] | null;
  /**
   * The revision's `policy_categories` — controlled keys from lib/catalog/category-map.ts, NOT the
   * provider's own category text. `null` is "no category evidence"; `[]` is "checked, none banned".
   */
  category: string[] | null;
  onEatsList: boolean;
  /** This account's own `user_food_prefs.status` for this food is `avoid`. */
  onAvoidList: boolean;
  /**
   * Phase 18 D4 (the "no evidence" row of the exclusions table): the evidence carries a derived,
   * deterministic state for EVERY allergen key (listed, clear or unknown: an open-world universe
   * item), so the legacy no-tag-list gate below never decides it. That gate
   * is the closed world's allow list (only an Eats mark lifts it); with this flag the verdict is
   * exactly the resolved marks. It clears nothing else: an avoided allergen still decides for
   * itself (an `unknown` state stays unverified), and every diet, category, custom and profile
   * rule still marks as before.
   */
  perAllergenEvidence?: true;
  /** Confirmed preferences are matched here in code, never sent to Jev. */
  preferenceFlags?: readonly PolicyPreferenceFlag[];
  /**
   * Phase 18 W2c: carried for callers' wire shape only. No rule decision reads a Jev facet; its
   * presence only selects the marks-bearing verdict shape (`enhanced` below).
   */
  facets?: Readonly<FoodFacetJudgments>;
  facetAction?: FacetPolicyAction;
  /** Explicit certification/preparation evidence for rules that absence cannot establish. */
  verifiedPreferenceFlags?: readonly PolicyPreferenceFlag[];
  /** Curated starter outcomes (lib/policy/diet-evidence.ts `attestedFacets`); never a model's. */
  attestedFacets?: DietEvidence["attestedFacets"];
  /**
   * Phase 13 §5: this revision's stored evidence per allergen key (food_allergen_evidence). An
   * allergen with no entry is `no_evidence`. Only a stored `not_listed` can clear a major allergen.
   */
  allergenEvidence?: Readonly<Record<string, StoredAllergenEvidence>>;
  /** Allergen keys this user has marked checked for this exact product (user_allergen_checks). */
  checkedAllergens?: readonly string[];
  /** The revision's ingredient text, when the caller has it: it can only add `listed`. */
  ingredientsText?: string | null;
  /**
   * Phase 13 §4, §9 R5: this account's dietary-profile rule items and the instant to judge them
   * at. Only an item `isActiveHardRule` accepts at `asOf` (a "never", a permitted basis, confirmed
   * one item at a time, unexpired, inside its calendar window) makes a mark — checked here, at
   * this boundary, not trusted from the caller. An allergy/celiac hard basis belongs in
   * `avoid_allergens` instead, not duplicated here.
   */
  profileRules?: ProfileRuleSet;
  /**
   * sol BLOCK (r5): whether `ingredientsText` above is a genuine printed/scanned label, not a
   * self-authored custom food's own editable field. Defaults to true (every existing caller
   * already passes real label text); see lib/policy/allergens.ts allergenFinding's own doc.
   */
  ingredientsTextIsLabel?: boolean;
  /**
   * finding #8: the food's own name/description, when the caller has it. §9 R1's pregnancy/tuna
   * check must catch a product NAMED "Canned tuna" even when its ingredient text says only
   * "Water, salt" and it carries no tuna tag — the name is itself evidence the ingredient list
   * alone cannot supply.
   */
  foodName?: string | null; wholeFoodName?: string | null; // 2026-10-03: whole-foods.ts clearanceNameOf
  /**
   * 2026-10-02 (owner decision): the food's own brand, when the caller has it. A branded row
   * never gets lib/policy/whole-foods.ts's whole-food clearance — only a generic, unbranded,
   * single-ingredient identity does.
   */
  foodBrand?: string | null;
  /**
   * 2026-10-02 DeepSeek audit (HIGH, finding #2): true for a scanned barcode or label lane —
   * packaged by definition, whether or not `foodBrand` above is set on this particular row.
   */
  packaged?: boolean;
  /** Per-serving nutrients, when the caller has them: a profile rule on high_sodium,
   *  added_sugar or protein_dense reads only these (lib/policy/profiles/new-facets.ts). */
  nutrientsPerServing?: Readonly<Partial<Record<NutrientCode, number>>>;
};

/** `jev` stays in the type for stored marks (lib/coach/ui-blocks.ts); since Phase 18 W2c no rule
 *  decision emits it — every mark comes from deterministic evidence. */
export type PolicyMarkSource = "floor" | "profile" | "avoid" | "ingredient" | "category" | "jev";
export type PolicyMark = {
  facet: string;
  p?: number;
  source: PolicyMarkSource;
  outcome: FacetOutcome;
};
export type PolicyVerdict = {
  verdict: "allowed" | "blocked" | "unverified";
  reason?: string;
  /** Present on the facet-aware path; legacy callers retain their existing wire shape. */
  marks?: PolicyMark[];
  /**
   * Phase 13 §5: one finding per allergen the account avoids, in the card's words ("Contains
   * sesame", "No egg listed on the label", "Check the label for gluten"). Present only when the
   * account avoids at least one allergen.
   */
  allergens?: AllergenFinding[];
};

/**
 * `floor` is the rank for an allergen the ACCOUNT's own profile names — its own floor, whatever
 * that account put in it.
 *
 * Until D1 §6.1 this module held `new Set(["gluten", "dairy", "apple"])` and gave only those
 * three the rank: one person's clinical rules deciding, in shared code, which allergens outranked
 * an avoid-list mark. The set is gone and the rank now applies to every allergen in the profile,
 * so the precedence a blocked answer reports no longer depends on which allergen it is.
 */
const SOURCE_ORDER: Record<PolicyMarkSource, number> = {
  floor: 0, profile: 1, avoid: 2, ingredient: 3, category: 4, jev: 5,
};

/**
 * blocked > unverified > allowed, and inside blocked: an allergen the profile names >
 * avoid_food_ref_ids > the avoid list > a preference flag's ingredient evidence > a banned
 * category > a legacy Jev mark (never emitted since W2c). Allergen and category comparisons
 * ignore case AND surrounding whitespace; `avoid_food_ref_ids` is an exact match (food ref ids
 * are already canonical uuids).
 *
 * The whitespace half is not cosmetic. Until 2026-09-14 this matched on case alone while the floor
 * guard in lib/server/constraints.ts compared a trimmed copy, so a stored "gluten " passed the
 * guard and then never matched the tag "gluten" — one trailing space silently switched gluten
 * blocking off. Writes are normalized now; this stays tolerant so an already-stored padded row
 * cannot bypass it either.
 */
/**
 * Owner direction 2026-10-08 ("no allow list"): the legacy no-tag-list gate below exists for an
 * allergen the evidence cannot speak to. An account that avoids NO allergen and has stated NO
 * condition has nothing for that gate to protect, so a food with no tag list follows the normal
 * verdict there instead of needing an Eats mark (the closed world's allow list). Fail closed:
 * `conditions` must have been read (the server profile readers always select it) and be empty; a
 * profile object without the field (EMPTY_PROFILE, a caller that never read the row) keeps the
 * gate. Any allergen rule or condition keeps today's behaviour exactly. Avoid, diet, category,
 * custom and profile rules mark before this point and are unchanged; no Jev input is read.
 */
export function noAllergenOrConditionRule(profile: ConstraintProfile): boolean {
  return profile.avoid_allergens.every((key) => !key.trim())
    && Array.isArray(profile.conditions) && profile.conditions.every((text) => !text.trim());
}

export function evaluatePolicy(profile: ConstraintProfile, e: PolicyEvidence): PolicyVerdict {
  const enhanced = e.facetAction !== undefined || e.preferenceFlags !== undefined
    || e.facets !== undefined || e.verifiedPreferenceFlags !== undefined
    || (profile.custom_rules?.length ?? 0) > 0;
  const findings = allergenFindings(profile, e);
  const marks = policyMarks(profile, e, findings);
  const resolved = resolvePolicyVerdict(marks);
  if (findings.length > 0) {
    // Phase 13 §5: with an active allergen rule, each allergen decides for itself. The Eats list
    // no longer clears it, and a legacy empty tag list is not evidence.
    const withFindings = { ...resolved, allergens: findings };
    return enhanced ? { ...withFindings, marks } : withFindings;
  }
  if (resolved.verdict !== "allowed" || e.allergenTags !== null || e.onEatsList || e.perAllergenEvidence
    || noAllergenOrConditionRule(profile)) {
    return enhanced ? { ...resolved, marks } : resolved;
  }
  const legacy = { verdict: "unverified" as const };
  return enhanced
    ? { ...legacy, marks: [...marks, {
      facet: "allergens", source: "ingredient", outcome: "unknown",
    }] }
    : legacy;
}

/**
 * The facets an "unknown" mark still leaves open: a lower-SOURCE_ORDER "absent" mark on the SAME
 * facet resolves it (an ingredient-level clearance outranks a weaker source's "unknown"), the
 * same way a `present` mark's rank decides `resolvePolicyVerdict`'s blocked reason below.
 *
 * Exported so a caller that needs to know WHICH facets are still open — not just whether the
 * record as a whole resolves — applies the identical rule rather than re-deriving it (2026-10-02
 * DeepSeek audit: lib/coach/log-policy.ts unresolvedPreferenceFlags used to keep a flag on ANY
 * unknown mark, blaming a preference whose own facet an absent mark had already cleared).
 */
export function unresolvedFacets(marks: readonly PolicyMark[]): Set<string> {
  return new Set(marks.filter((mark) => mark.outcome === "unknown" && !marks.some((other) =>
    other.facet === mark.facet && other.outcome === "absent"
    && SOURCE_ORDER[other.source] < SOURCE_ORDER[mark.source])).map((mark) => mark.facet));
}

/** The precedence boundary: blockers win by floor/avoid → ingredient → category. */
export function resolvePolicyVerdict(marks: readonly PolicyMark[]): PolicyVerdict {
  const present = [...marks]
    .filter((mark) => mark.outcome === "present")
    .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source])[0];
  if (present) return { verdict: "blocked", reason: reasonFor(present) };

  return unresolvedFacets(marks).size > 0 ? { verdict: "unverified" } : { verdict: "allowed" };
}

/** One finding per distinct allergen the account avoids (Phase 13 §5). */
function allergenFindings(profile: ConstraintProfile, e: PolicyEvidence): AllergenFinding[] {
  const avoided = [...new Set(profile.avoid_allergens.map(normalize).filter(Boolean).map(allergenKey))];
  // finding #9: avoiding the combined `shellfish` setting also judges the FALCPA-major crustacean
  // allergen on its own — see withCrustaceanAllowance.
  const keys = withCrustaceanAllowance(avoided);
  const checked = new Set((e.checkedAllergens ?? []).map(allergenKey));
  const evidence = new Map(Object.entries(e.allergenEvidence ?? {})
    .map(([key, value]) => [allergenKey(key), value]));
  // Phase 18 W2a: no Jev judgment reaches an allergen decision (tests/policy/facet-escalation-removal).
  const findings = keys.map((key) => allergenFinding(key, {
    stored: evidence.get(key),
    tags: e.allergenTags,
    ingredientsText: e.ingredientsText,
    userChecked: checked.has(key),
    isLabelText: e.ingredientsTextIsLabel,
    foodName: e.foodName, brand: e.foodBrand, packaged: e.packaged, wholeFoodName: e.wholeFoodName,
  }));
  // §9 R1: independent of the account's own avoid list — a pregnancy profile stays unverified
  // for unspecified tuna even when fish is not one of its allergens.
  const tuna = pregnancyTunaFinding({
    conditions: profile.conditions, profileIds: profile.profileIds,
    ingredientsText: e.ingredientsText, tags: e.allergenTags, foodName: e.foodName,
  });
  return tuna ? [...findings, tuna] : findings;
}

function policyMarks(
  profile: ConstraintProfile, e: PolicyEvidence, findings: readonly AllergenFinding[],
): PolicyMark[] {
  const categories = (e.category ?? nameCategories(e.foodName))?.map(normalize) ?? null;
  const bySource: Record<PolicyMarkSource, PolicyMark[]> = {
    floor: [], profile: [], avoid: [], ingredient: [], category: [], jev: [],
  };

  // A cleared allergen adds no mark: its finding is in the verdict's `allergens` already.
  for (const finding of findings) {
    if (finding.outcome === "absent") continue;
    bySource.floor.push({ facet: finding.allergen, source: "floor", outcome: finding.outcome });
  }
  // Phase 13 §4: religious/user_rule/user_confirmed_safety hard rules — allergy/celiac stay on
  // the allergen floor above. Each item's confirmation, basis, expiry and window is checked here.
  bySource.profile.push(...activeConfirmedHardMarks(e.profileRules, e));
  for (const rule of profile.custom_rules ?? []) {
    if (!isCustomRule(rule)) {
      bySource.profile.push({ facet: "custom_rule_invalid", source: "profile", outcome: "unknown" });
      continue;
    }
    if (ingredientRuleMatches(rule, [e.foodName ?? "", e.ingredientsText ?? ""])) {
      bySource.profile.push({ facet: `custom_ingredient:${rule.text}`, source: "profile", outcome: "present" });
    } else if (rule.kind === "ingredient" && e.ingredientsTextIsLabel !== true
      && mayHaveSubingredients(e.foodName ?? "")) {
      // A name or partial ingredient list cannot clear an exclusion for a prepared food.
      // Whole single-ingredient identities do not inherit this missing-label penalty.
      bySource.profile.push({ facet: `custom_ingredient:${rule.text}`, source: "profile", outcome: "unknown" });
    }
  }
  if ((e.foodRefId !== null && profile.avoid_food_ref_ids.includes(e.foodRefId)) || e.onAvoidList) {
    bySource.avoid.push({ facet: "avoid_list", source: "avoid", outcome: "present" });
  }
  if (categories) {
    const banned = new Set(profile.banned_categories.map(normalize));
    for (const raw of e.category ?? categories) {
      if (banned.has(normalize(raw))) {
        bySource.category.push({ facet: raw, source: "category", outcome: "present" });
      }
    }
  }

  // Phase 18 W2c: preference flags read deterministic evidence only (lib/policy/preference-marks.ts).
  for (const mark of preferenceMarks([...new Set(e.preferenceFlags ?? [])],
    new Set(e.verifiedPreferenceFlags ?? []), e)) bySource[mark.source].push(mark);
  return dedupe([
    ...bySource.floor, ...bySource.profile, ...bySource.avoid, ...bySource.ingredient,
    ...bySource.category, ...bySource.jev,
  ]);
}

/**
 * Diet facets that are not allergens. Before W2c they could only block through a Jev mark
 * (`facet:<facet>`); now the food's own evidence blocks them at the ingredient source, and they
 * keep the `facet:` reason so no reader (lib/server/coach.ts `blockedAllergen`, the "Contains …"
 * copy) mistakes "meat" or "alcohol" for an allergen.
 */
const NON_ALLERGEN_DIET_FACETS = new Set([
  "meat", "pork", "beef", "fish_seafood", "animal_product", "alcohol",
]);

function reasonFor(mark: PolicyMark): string {
  if (mark.source === "profile") return `rule:${mark.facet}`;
  if (mark.source === "avoid") return "avoid_list";
  if (mark.source === "category") return `category:${mark.facet}`;
  if (mark.source === "jev" || NON_ALLERGEN_DIET_FACETS.has(mark.facet)) return `facet:${mark.facet}`;
  return `allergen:${mark.facet.replace(/^contains_/, "")}`;
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function dedupe(marks: readonly PolicyMark[]): PolicyMark[] {
  const seen = new Set<string>();
  return marks.filter((mark) => {
    const key = `${mark.source}:${mark.facet}:${mark.outcome}:${mark.p ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `null` (no row for this account yet) resolves to EMPTY_PROFILE; a partial row fills each
 * missing array empty rather than merging field contents. */
export function loadProfile(row: Partial<ConstraintProfile> | null): ConstraintProfile {
  if (row === null) return EMPTY_PROFILE;
  return {
    avoid_allergens: row.avoid_allergens ?? EMPTY_PROFILE.avoid_allergens,
    avoid_food_ref_ids: row.avoid_food_ref_ids ?? EMPTY_PROFILE.avoid_food_ref_ids,
    banned_categories: row.banned_categories ?? EMPTY_PROFILE.banned_categories,
    ...(row.custom_rules === undefined ? {} : { custom_rules: parseCustomRules(row.custom_rules) }),
    conditions: row.conditions ?? [],
  };
}
