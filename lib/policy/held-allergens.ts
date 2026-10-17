import { HELD_ALLERGEN_TEXT } from "@/lib/policy/allergen-holds";
import type { StoredAllergenEvidence } from "@/lib/policy/allergens";

/**
 * The allergen keys whose stored evidence is a W2a hold (a Jev-only `listed`), sorted. A hold is
 * neither a block nor a clearance, so a "checked the label" answer cannot settle it: the food
 * sheet shows the held copy for these keys instead of offering the check.
 */
export function heldAllergenKeys(evidence: Readonly<Record<string, StoredAllergenEvidence>>): string[] {
  return Object.keys(evidence).filter((key) => evidence[key]?.held === true).sort();
}

/**
 * The one line every surface shows for a held allergen: the allergen's name, then the shared
 * "Not verified. Evidence under review" words. A hold never reads as a clearance or a block, so
 * no surface words it any other way (W101).
 */
export function heldAllergenLine(allergenLabel: string): string {
  return `${allergenLabel}: ${HELD_ALLERGEN_TEXT}`;
}
