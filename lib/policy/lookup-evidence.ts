/**
 * Phase 13 §9 R8 (slice 6): "grounding never clears a hard rule." A `lookup` answer is a model's
 * read of a web search, not a parsed label — it can never become `listed` or `not_listed`
 * allergen evidence (lib/policy/allergens.ts), whatever it claims. This is the one function that
 * turns a lookup answer into evidence, and it is a constant: every lookup answer, "peanut-free" or
 * not, caps out at `no_evidence` ("unverified"). Merged with any stored evidence via
 * `mergeEvidence`, a `listed` hard block never moves.
 *
 * Pure. No I/O.
 */
import type { StoredAllergenEvidence } from "@/lib/policy/allergens";

/** Always `no_evidence`: a lookup claim is never evidence a hard rule can be cleared by. */
export function capLookupEvidence(): StoredAllergenEvidence {
  return { level: "no_evidence", labelComplete: false };
}
