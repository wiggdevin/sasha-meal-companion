/**
 * The preference-flag marks `evaluatePolicy` reads (split out of lib/policy/constraints.ts for the
 * file-size cap). Phase 18 W2c (docs/specs/phase-18-open-world-foods.md D4, D9): no Jev facet
 * decides a preference flag. Each rule facet reads, in order:
 *
 * 1. A category rule (low FODMAP) reads stored `policy_categories` only, as before W2c.
 * 2. An ingredient tag that names the facet blocks. A tag list that does not name it is not proof
 *    of absence (the allergen floor's own rule): before W2c a Jev `present` overrode it, so letting
 *    it clear now would turn a Jev-only flag into `allowed`.
 * 3. Otherwise the food's own deterministic evidence (lib/policy/diet-evidence.ts): its name and
 *    ingredient text, stored non-Jev allergen evidence and the whole-food class (a complete label
 *    blocks what it names and clears alcohol only, never an animal facet).
 *
 * A facet nothing deterministic decides is `unknown`, so the food is `unverified`, never `allowed`.
 * A Jev `present` no longer blocks and a Jev `absent` no longer clears.
 *
 * Pure. No I/O.
 */
import { dietFacetOutcome, facetHeld, type DietEvidence } from "@/lib/policy/diet-evidence";
import {
  FACET_RULES, type FacetOutcome, type PolicyPreferenceFlag,
} from "@/lib/policy/facet-rules";

export type PreferenceMark = {
  facet: string;
  source: "ingredient" | "category";
  outcome: FacetOutcome;
};

const normalize = (value: string) => value.toLowerCase().trim();

/**
 * Every mark the account's preference flags put on one food. `verified` holds the flags this food
 * carries explicit certification or preparation evidence for (halal, kosher): only those clear a
 * rule that absence of a forbidden ingredient cannot establish.
 */
export function preferenceMarks(
  flags: readonly PolicyPreferenceFlag[],
  verified: ReadonlySet<PolicyPreferenceFlag>,
  e: DietEvidence,
): PreferenceMark[] {
  const tags = e.allergenTags?.map(normalize) ?? null;
  // Stored categories only: a name-derived list is for bans, never "checked clean" (DeepSeek r6).
  const categories = e.category?.map(normalize) ?? null;
  const marks: PreferenceMark[] = [];
  for (const flag of flags) {
    const isVerified = verified.has(flag);
    for (const rule of FACET_RULES[flag]) {
      // A W2a hold is never cleared, certification included (W2c r1).
      const certified = isVerified && rule.requiresVerification === true && !facetHeld(rule.facet, e);
      const det = rule.deterministic;
      if (det?.source === "category") {
        // Stored policy categories are complete evidence either way (`[]` is "checked, clean");
        // a food never annotated stays unknown. Jev never read these rules.
        marks.push({ facet: rule.facet, source: "category", outcome: categories === null ? "unknown"
          : categories.some((item) => det.keys.map(normalize).includes(item)) ? "present" : "absent" });
        continue;
      }
      // A tag that names the facet blocks. A tag list that does not is not proof of absence (the
      // allergen floor's rule, Phase 13 §5): absence needs the food's own evidence below.
      if (det && tags !== null && tags.some((item) => det.keys.map(normalize).includes(item))) {
        marks.push({ facet: rule.facet, source: "ingredient", outcome: "present" });
        continue;
      }
      const derived = dietFacetOutcome(rule.facet, e);
      if (derived !== "unknown") {
        marks.push({ facet: rule.facet, source: "ingredient", outcome: derived });
      } else if (!certified) {
        marks.push({ facet: rule.facet, source: "ingredient", outcome: "unknown" });
      }
      if (certified) marks.push({ facet: rule.facet, source: "ingredient", outcome: "absent" });
    }
    // Absence of a forbidden ingredient cannot establish certification or preparation.
    const needsCertificate = FACET_RULES[flag].some((rule) => rule.requiresVerification);
    if (needsCertificate && !isVerified && !FACET_RULES[flag].some((rule) =>
      marks.some((mark) => mark.facet === rule.facet && mark.outcome === "present"))) {
      marks.push({ facet: flag, source: "ingredient", outcome: "unknown" });
    }
  }
  return marks;
}
