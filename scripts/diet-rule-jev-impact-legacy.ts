/**
 * Phase 18 W2c impact report, the "before" half: the diet, religious and profile rule decisions as
 * they were before W2c, when cached Jev facets blocked and cleared preference flags and profile
 * hard rules. Kept ONLY for the offline, read-only report (scripts/diet-rule-jev-impact.ts); no app
 * path imports this file (tests/policy/diet-rule-jev-removal.test.ts checks it).
 *
 * The verdict is split the same way `evaluatePolicy` builds it: everything except the preference
 * flags and the profile hard rules (allergens, Avoid, categories, custom rules, the legacy
 * no-evidence gate) is the unchanged `base`; the two rule groups are re-marked here with the old
 * logic and resolved with the app's own `resolvePolicyVerdict`. Pure.
 */
import { FACETS, type Facet } from "@/lib/foods/facet-vocabulary";
import {
  evaluatePolicy, resolvePolicyVerdict, type ConstraintProfile, type PolicyEvidence, type PolicyMark,
  type PolicyMarkSource, type PolicyVerdict,
} from "@/lib/policy/constraints";
import { FACET_RULES, facetOutcome } from "@/lib/policy/facet-rules";
import { profileFacetOutcome } from "@/lib/policy/profiles/hard-rules";
import { isActiveHardRule } from "@/lib/policy/profiles/types";
import { absentAnimalFacets, classifyWholeFood, clearanceNameOf } from "@/lib/policy/whole-foods";

type Verdict = PolicyVerdict["verdict"];
const FACET_SET = new Set<string>(FACETS);
const SOURCES: readonly PolicyMarkSource[] = ["floor", "profile", "avoid", "ingredient", "category", "jev"];
const normalize = (value: string) => value.toLowerCase().trim();

/** Every verdict, worst first: blocked beats unverified beats allowed. */
export function combineVerdicts(...verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("blocked")) return "blocked";
  return verdicts.includes("unverified") ? "unverified" : "allowed";
}

/** The verdict without preference flags or profile hard rules: the half W2c did not change. */
export function baseVerdict(profile: ConstraintProfile, e: PolicyEvidence): Verdict {
  return evaluatePolicy(profile, { ...e, preferenceFlags: [], verifiedPreferenceFlags: [],
    profileRules: undefined }).verdict;
}

/** The pre-W2c preference marks: a cached Jev facet blocked (`present`) or cleared (`absent`). */
export function legacyPreferenceMarks(e: PolicyEvidence): PolicyMark[] {
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, [] as PolicyMark[]])) as
    Record<PolicyMarkSource, PolicyMark[]>;
  const tags = e.allergenTags?.map(normalize) ?? null;
  const categories = e.category?.map(normalize) ?? null;
  const action = e.facetAction ?? "exclude";
  const flags = [...new Set(e.preferenceFlags ?? [])];
  const verified = new Set(e.verifiedPreferenceFlags ?? []);
  for (const flag of flags) {
    const isVerified = verified.has(flag);
    const categoriesOnly = flag === "low_fodmap";
    for (const rule of FACET_RULES[flag]) {
      const det = rule.deterministic;
      if (det) {
        const evidence = det.source === "ingredient" ? tags : categories;
        if (evidence !== null) {
          const keys = det.keys.map(normalize);
          bySource[det.source].push({ facet: rule.facet, source: det.source,
            outcome: evidence.some((item) => keys.includes(item)) ? "present" : "absent" });
        } else if ((det.source === "ingredient" || categoriesOnly)
          && !(isVerified && rule.requiresVerification)) {
          bySource[det.source].push({ facet: rule.facet, source: det.source, outcome: "unknown" });
        }
      }
      if (isVerified && rule.requiresVerification) {
        bySource.ingredient.push({ facet: rule.facet, source: "ingredient", outcome: "absent" });
      }
      if (categoriesOnly) continue;
      const p = e.facets?.[rule.facet]?.p;
      bySource.jev.push({ facet: rule.facet, ...(p === undefined ? {} : { p }), source: "jev",
        outcome: facetOutcome(rule.facet, p, action) });
    }
  }
  bySource.ingredient = legacyWholeFood(bySource.ingredient,
    flags.flatMap((flag) => FACET_RULES[flag]), e);
  for (const flag of flags) {
    if (!FACET_RULES[flag].some((rule) => rule.requiresVerification) || verified.has(flag)) continue;
    const first = (facet: Facet) => SOURCES.flatMap((s) => bySource[s]).find((m) => m.facet === facet);
    if (!FACET_RULES[flag].some((rule) => first(rule.facet)?.outcome === "present")) {
      bySource.jev.push({ facet: flag, source: "jev", outcome: "unknown" });
    }
  }
  return SOURCES.flatMap((source) => bySource[source]);
}

/** The pre-W2c whole-food step: only the animal facets, and only over ingredient-level marks. */
function legacyWholeFood(marks: PolicyMark[], rules: readonly { facet: string }[], e: PolicyEvidence) {
  if (rules.length === 0) return marks;
  const match = classifyWholeFood({ foodName: clearanceNameOf(e), brand: e.foodBrand,
    ingredientsText: e.ingredientsText, packaged: e.packaged });
  if (!match) return marks;
  const ruled = new Set(absentAnimalFacets(match));
  return [...marks.filter((mark) => !(ruled.has(mark.facet) && mark.outcome === "unknown")),
    ...rules.filter((rule) => ruled.has(rule.facet))
      .map((rule): PolicyMark => ({ facet: rule.facet, source: "ingredient", outcome: "absent" }))];
}

/** The pre-W2c profile hard-rule marks: a frozen facet read its cached Jev probability. */
export function legacyProfileMarks(e: PolicyEvidence): PolicyMark[] {
  const rules = e.profileRules;
  const marks: PolicyMark[] = [];
  for (const rule of rules?.items ?? []) {
    if (!isActiveHardRule(rule, rules!.asOf)) continue;
    const outcome = FACET_SET.has(rule.facet)
      ? facetOutcome(rule.facet as Facet, e.facets?.[rule.facet as Facet]?.p, e.facetAction ?? "exclude")
      : profileFacetOutcome(rule.facet, e);
    if (outcome !== "absent") marks.push({ facet: rule.facet, source: "profile", outcome });
  }
  return marks;
}

/** The verdict this food had before W2c. */
export function legacyVerdict(profile: ConstraintProfile, e: PolicyEvidence): Verdict {
  const rules = resolvePolicyVerdict([...legacyProfileMarks(e), ...legacyPreferenceMarks(e)]);
  return combineVerdicts(baseVerdict(profile, e), rules.verdict);
}
