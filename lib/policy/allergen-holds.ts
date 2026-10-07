/**
 * Phase 18 W2a (D4, D9): Jev is never on the allergy path. Evidence is derived from deterministic
 * inputs only — the label or ingredient text, legacy tags, the food's own name, stored non-Jev
 * evidence, the whole-food class and the user's exact-product check. A stored row that only Jev
 * ever flagged (`level = 'listed', source = 'jev'`) is read as a HOLD (`held: true`): the food is
 * unverified for that allergen, never allowed — not by a complete label, not by the whole-food
 * class, not by the user's check. Only a logged evidence review that replaces the row with
 * deterministic evidence lifts it (scripts/allergen-jev-holds.ts). A deterministic `listed` beside
 * a hold still blocks.
 */
import type { AllergenLevel, StoredAllergenEvidence } from "@/lib/policy/allergens";

/** The finding text for a held allergen (W2a). The UI lane owns the final copy (spec §7.2). */
export const HELD_ALLERGEN_TEXT = "Not verified. Evidence under review";

/** The stored row `source` that marks a Jev-only flag. */
export const JEV_EVIDENCE_SOURCE = "jev";

/** A stored row read into evidence: a `listed` row whose source is Jev becomes a hold. */
export function storedEvidenceFromRow(row: {
  level: AllergenLevel; labelComplete: boolean; source?: string | null;
}): StoredAllergenEvidence {
  return row.level === "listed" && row.source === JEV_EVIDENCE_SOURCE
    ? { level: "listed", labelComplete: row.labelComplete, held: true }
    : { level: row.level, labelComplete: row.labelComplete };
}

/** A deterministic `listed`: a block, as opposed to a hold. */
export function isDeterministicListed(evidence: StoredAllergenEvidence | undefined): boolean {
  return evidence?.level === "listed" && evidence.held !== true;
}
