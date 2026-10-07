/**
 * Phase 13 slice 4 (§4, §9 R5): the one place a stored account's confirmed profile instances turn
 * into the `ProfileRuleSet` `evaluatePolicy` reads (lib/policy/constraints.ts's `profileRules`)
 * — everything `rankFoods` needs it already takes as `ProfileInstance[]` directly
 * (lib/policy/profiles/rank-foods.ts), so this module carries only the hard-rule half.
 *
 * `isActiveHardRule` is the single gate (confirmed, a permitted basis, not expired): a
 * `user_confirmed_safety` item the user has not individually confirmed — the "medical rule
 * unconfirmed until the user confirms" case (R5) — never reaches the list this builds, same as it
 * never reached one before this module existed. Pure: no I/O, no wall-clock read.
 */
import { FACETS, type Facet } from "@/lib/foods/facet-vocabulary";
import { isActiveHardRule, type ProfileInstance, type RuleItem } from "@/lib/policy/profiles/types";
import type { ProfileRuleSet } from "@/lib/policy/profiles/hard-rules";

const FACET_SET = new Set<string>(FACETS);

export function activeHardRulesFor(
  instances: readonly ProfileInstance[],
  now: Date,
): ProfileRuleSet {
  // evaluatePolicy re-checks every item with isActiveHardRule at its own boundary (slice 3 review);
  // the filter here keeps the set small and documents the same gate at the source.
  const items: RuleItem[] = [];
  for (const instance of instances) {
    for (const rule of instance.rules) {
      if (isActiveHardRule(rule, now)) items.push(rule);
    }
  }
  return { items, asOf: now };
}

/** The frozen facets these rules name. Phase 18 W2c: no rule decision reads their cached Jev
 *  judgments any more (hard-rules.ts decides from deterministic evidence); callers still read them
 *  so the offline impact report (scripts/diet-rule-jev-impact.ts) can compare. Never a model call. */
export function profileRuleFacets(ruleSet: ProfileRuleSet | undefined): Facet[] {
  const facets = new Set<Facet>();
  for (const rule of ruleSet?.items ?? []) {
    if (FACET_SET.has(rule.facet)) facets.add(rule.facet as Facet);
  }
  return [...facets];
}
