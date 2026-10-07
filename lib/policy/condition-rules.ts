/**
 * EMPTY BY DESIGN (v1).
 *
 * A diagnosis never activates a food facet or dietary warning. Any future rule requires
 * nutritionist-approved evidence, exact user-facing copy, applicability boundaries, and a
 * labelled evaluation. A user-confirmed low_fodmap preference remains a preference, not a rule
 * inferred from a condition. Full condition PACKS (soft rules, facets, `user_confirmed_safety`
 * items) stay out of scope for slice 3 behind `CONDITION_PACKS_ENABLED` (§7, §9 R5/R6).
 *
 * §9 R1's "Unspecified tuna is unverified for the pregnancy profile" clause (review round 2,
 * spec + sol lens BLOCK) is NOT one of those — it is one literal, fixed-wording, spec-mandated
 * exception with no facet and no nutritionist copy to calibrate, so it does not wait on the
 * profile-instance rebuild. It is implemented in lib/policy/pregnancy-tuna.ts, reading the
 * account's existing free-text `constraint_profiles.conditions`, and wired into
 * lib/policy/constraints.ts's own findings list — never through this table.
 */
export const CONDITION_RULES: readonly never[] = [];
