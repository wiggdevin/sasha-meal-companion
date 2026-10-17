"use client";

import { HELD_ALLERGEN_TEXT } from "@/lib/policy/allergen-holds";
import { heldAllergenLine } from "@/lib/policy/held-allergens";
import { CROSS_CONTACT_NOTE } from "@/lib/policy/allergens";
import { ruleLabel } from "@/lib/reference";

const META = "text-tiny font-normal text-muted";
const LINE = "text-tiny font-normal text-warning";

/**
 * Only the fields this component reads — deliberately narrower than `AllergenFinding` so it also
 * accepts `ProposeResponse["labelFood"]["allergenWarnings"]`'s wire shape, which drops
 * `checkable` (nothing on the label card lets you mark a scanned label's own reading checked).
 */
type FindingLine = { allergen: string; outcome: "present" | "absent" | "unknown"; text: string };

/**
 * W2a UI copy (spec §7.2): a held finding's own `text` is the generic `HELD_ALLERGEN_TEXT`, with
 * no allergen name — fine for one line alone, but indistinguishable from any other held line when
 * a food holds more than one. Naming the allergen here (never retyping the constant) is the only
 * change this lane makes to a held line's words.
 */
function lineText(finding: FindingLine): string {
  return finding.text === HELD_ALLERGEN_TEXT
    ? heldAllergenLine(ruleLabel(finding.allergen)) : finding.text;
}

/**
 * finding #11: the smallest shared piece of what a food's allergen findings say — one line per
 * finding, in the card's own words ("Contains sesame", "No egg listed on the label", "Check the
 * label for gluten", the pregnancy/tuna mercury note), plus the cross-contact caveat whenever
 * anything is not a flat "present". Never "safe"; logging or saving is never blocked by these
 * lines. No wrapping element of its own — each caller keeps its own container and aria-label.
 *
 * Shared by the barcode card (AllergenCheck.tsx), a scanned label's own card
 * (LabelAllergenLines.tsx) and a matched photo/voice/label capture item's row
 * (CaptureDraftEditor.tsx) — that last one used to show only the verdict's colour dot, never why.
 */
export default function AllergenFindingLines({
  findings,
}: {
  findings: readonly FindingLine[];
}) {
  if (findings.length === 0) return null;
  return (
    <>
      {findings.map((finding) => (
        <span key={finding.allergen} role={finding.outcome === "present" ? "alert" : undefined}
          className={finding.outcome === "absent" ? META : LINE}>{lineText(finding)}</span>
      ))}
      {findings.some((finding) => finding.outcome !== "present")
        && <span className={META}>{CROSS_CONTACT_NOTE}</span>}
    </>
  );
}
