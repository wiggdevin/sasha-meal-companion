import { HELD_ALLERGEN_TEXT } from "@/lib/policy/allergen-holds";
import type { AllergenFinding, StoredAllergenEvidence } from "@/lib/policy/allergens";
import { ruleLabel } from "@/lib/reference";

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

/**
 * What follows a food's name when allergens are left unknown (Today's rule mark, the swap and
 * suggestion cards, a shopping line): held ones read as the shared held line, the rest as "cannot
 * be checked". "Peanut butter needs review. Peanut: Not verified. Evidence under review." Null when
 * no finding is unknown. A held finding is the one `allergenFinding` gives `HELD_ALLERGEN_TEXT`.
 */
export function unknownAllergenFragment(
  findings: readonly Pick<AllergenFinding, "allergen" | "outcome" | "text">[],
): string | null {
  const unknown = findings.filter((finding) => finding.outcome === "unknown");
  if (unknown.length === 0) return null;
  const held = unknown.filter((finding) => finding.text === HELD_ALLERGEN_TEXT)
    .map((finding) => `${heldAllergenLine(ruleLabel(finding.allergen))}.`);
  const open = unknown.filter((finding) => finding.text !== HELD_ALLERGEN_TEXT)
    .map((finding) => finding.allergen.replace(/_/g, " "));
  const lead = open.length > 0 ? `cannot be checked for ${open.join(", ")}.` : "needs review.";
  return [lead, ...held].join(" ");
}
