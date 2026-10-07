import { FACET_THRESHOLDS } from "@/lib/foods/facet-thresholds";
import type { Facet } from "@/lib/foods/facet-vocabulary";
import type { PreferenceFlag } from "@/lib/profile/onboarding-state";

export type FacetPolicyAction = "mark" | "exclude";
export type FacetOutcome = "present" | "absent" | "unknown";
export type PolicyPreferenceFlag = PreferenceFlag;

/**
 * One facet a preference flag rules out. Phase 18 W2c: a rule is decided by deterministic evidence
 * only — `deterministic` (tags or stored categories) when present, else the food's own name, text,
 * stored allergen evidence or whole-food class (lib/policy/diet-evidence.ts; a complete label
 * clears alcohol only, never an animal facet). The
 * facet name is the shared vocabulary; no Jev judgment of it blocks or clears a food.
 */
export type FacetRule = {
  facet: Facet;
  deterministic?: { source: "ingredient" | "category"; keys: readonly string[] };
  /** Absence of forbidden ingredients cannot prove religious certification or preparation. */
  requiresVerification?: boolean;
};

const vegetarian = [
  { facet: "meat" },
  { facet: "fish_seafood" },
  { facet: "shellfish", deterministic: ingredient("shellfish") },
] as const satisfies readonly FacetRule[];

export const FACET_RULES: Record<PolicyPreferenceFlag, readonly FacetRule[]> = {
  vegetarian,
  vegan: [{ facet: "animal_product" }, ...vegetarian],
  pescatarian: [{ facet: "meat" }, { facet: "pork" }, { facet: "beef" }],
  no_pork: [{ facet: "pork" }],
  no_beef: [{ facet: "beef" }],
  no_shellfish: [{ facet: "shellfish", deterministic: ingredient("shellfish") }],
  no_eggs: [{ facet: "contains_egg", deterministic: ingredient("egg", "eggs") }],
  no_soy: [{ facet: "contains_soy", deterministic: ingredient("soy") }],
  no_peanuts: [{ facet: "contains_peanut", deterministic: ingredient("peanut", "peanuts") }],
  low_fodmap: [
    { facet: "onion_garlic", deterministic: category("onion_garlic") },
    { facet: "beans", deterministic: category("beans") },
  ],
  halal: [
    { facet: "pork", requiresVerification: true },
    { facet: "alcohol", requiresVerification: true },
  ],
  kosher: [
    { facet: "pork", requiresVerification: true },
    { facet: "shellfish", deterministic: ingredient("shellfish"), requiresVerification: true },
  ],
};

export function facetRulesFor(flags: readonly PolicyPreferenceFlag[]): FacetRule[] {
  const seen = new Set<string>();
  return flags.flatMap((flag) => FACET_RULES[flag]).filter((rule) => {
    const key = `${rule.facet}:${rule.deterministic?.source ?? "evidence"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Classifies a cached probability using C6b's generated per-facet, per-action freeze. Phase 18
 * W2c: no diet, religious or profile rule calls this; it serves non-rule judgments only
 * (`human_food`, `requires_preparation`) and offline reports.
 */
export function facetOutcome(
  facet: Facet,
  p: number | undefined,
  action: FacetPolicyAction,
): FacetOutcome {
  if (p === undefined || !Number.isFinite(p) || p < 0 || p > 1) return "unknown";
  const band = FACET_THRESHOLDS[facet][action];
  if (p >= band.present) return "present";
  if (p <= band.absent) return "absent";
  return "unknown";
}

function ingredient(...keys: string[]): FacetRule["deterministic"] {
  return { source: "ingredient", keys };
}

function category(...keys: string[]): FacetRule["deterministic"] {
  return { source: "category", keys };
}
