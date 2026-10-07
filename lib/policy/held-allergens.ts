import type { StoredAllergenEvidence } from "@/lib/policy/allergens";

/**
 * The allergen keys whose stored evidence is a W2a hold (a Jev-only `listed`), sorted. A hold is
 * neither a block nor a clearance, so a "checked the label" answer cannot settle it: the food
 * sheet shows the held copy for these keys instead of offering the check.
 */
export function heldAllergenKeys(evidence: Readonly<Record<string, StoredAllergenEvidence>>): string[] {
  return Object.keys(evidence).filter((key) => evidence[key]?.held === true).sort();
}
