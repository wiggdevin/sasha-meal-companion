/**
 * Phase 13 §4/§9 R5: `rankFoods(profileInstances, facets, nutrients)` — the map's §7.2 pure
 * ranking function. Soft and prefer lists feed this; hard lists feed `evaluatePolicy`
 * (lib/policy/constraints.ts) instead, and its precedence is unchanged (§4). This module never
 * imports evaluatePolicy and its return type carries no verdict field, so it structurally cannot
 * change one — only a score and the reasons behind it. Pure: no I/O.
 */
import type { NutrientCode } from "@/lib/nutrients/codes";
import type { FacetOutcome } from "@/lib/policy/facet-rules";
import type { ProfileInstance, RuleStrength } from "@/lib/policy/profiles/types";

export type RankReason = { profileId: string; facet: string; strength: RuleStrength; weight: number };
export type RankResult = { score: number; reasons: readonly RankReason[] };

/** Points per soft strength when its facet reads "present". `never` never appears here: a hard
 *  rule's block is evaluatePolicy's job, not a rank weight. */
const WEIGHTS: Partial<Record<RuleStrength, number>> = {
  avoid: -5,
  limit: -2,
  sometimes: -0.5,
  prefer: 3,
};

export function rankFoods(
  profileInstances: readonly ProfileInstance[],
  facets: Readonly<Partial<Record<string, FacetOutcome>>>,
  // Accepted for target-modifier-driven scoring (e.g. a sodium cap) in a later slice; unread by
  // the weight table above, which only reads `facets`.
  _nutrients?: Readonly<Partial<Record<NutrientCode, number>>>,
): RankResult {
  const reasons: RankReason[] = [];
  let score = 0;
  for (const instance of profileInstances) {
    for (const rule of instance.rules) {
      if (rule.confirmation !== "confirmed" || rule.strength === "never") continue;
      const weight = WEIGHTS[rule.strength];
      if (weight === undefined) continue;
      if (facets[rule.facet] !== "present") continue;
      score += weight;
      reasons.push({ profileId: instance.profileId, facet: rule.facet, strength: rule.strength, weight });
    }
  }
  return { score, reasons };
}
