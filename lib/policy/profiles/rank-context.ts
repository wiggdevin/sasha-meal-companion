/**
 * Phase 13 slice 7: the glue between a confirmed profile's soft rules and
 * lib/policy/profiles/rank-foods.ts's `facets` argument. `rankFoods` takes a plain
 * `Partial<Record<string, FacetOutcome>>` and is deliberately ignorant of where it came from
 * (§4/§9 R5: it never imports `evaluatePolicy`); this module is the one place that resolves each
 * rule's facet the same way the hard-rule path does (lib/policy/profiles/hard-rules.ts's
 * `profileFacetOutcome`), so a `food_named:` or `contains_allergen:` rule reads identically
 * whether it ranks or blocks. Pure: no I/O.
 */
import type { FacetOutcome } from "@/lib/policy/facet-rules";
import { profileFacetOutcome, type ProfileFacetEvidence } from "@/lib/policy/profiles/hard-rules";
import type { ProfileInstance } from "@/lib/policy/profiles/types";

/**
 * Only the facets at least one instance's rules actually reference are resolved — a candidate
 * food with a long ingredient list costs nothing extra for facets nobody's profile cares about.
 */
export function facetsForFood(
  instances: readonly ProfileInstance[],
  evidence: ProfileFacetEvidence,
): Partial<Record<string, FacetOutcome>> {
  const facets: Partial<Record<string, FacetOutcome>> = {};
  for (const instance of instances) {
    for (const rule of instance.rules) {
      if (facets[rule.facet] !== undefined) continue;
      facets[rule.facet] = profileFacetOutcome(rule.facet, evidence);
    }
  }
  return facets;
}
