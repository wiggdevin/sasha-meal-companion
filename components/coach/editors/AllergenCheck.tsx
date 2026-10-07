"use client";

import { useState } from "react";
import type { BarcodeMatch } from "@/lib/barcode/client";
import AllergenFindingLines from "@/components/coach/editors/AllergenFindingLines";
import { markAllergenChecked } from "@/lib/foods/allergen-check-client";

const META = "text-tiny font-normal text-muted";

/**
 * Phase 13 §5 and §9 R1 on the barcode card: what the scanned label says about each allergen the
 * account avoids ("Contains sesame", "No egg listed on the label", "Check the label for gluten"),
 * and, while the user holds the product, "I checked the label" for this exact product. Never "safe";
 * logging is never blocked by it.
 */
export default function AllergenCheck({ match }: { match: BarcodeMatch }) {
  const [state, setState] = useState<"idle" | "saving" | "done" | "failed">("idle");
  const findings = match.policy.allergens ?? [];
  if (findings.length === 0) return null;
  const checkable = findings.some((finding) => finding.checkable);
  // sol FIX (review round 1, finding #4): once the mark succeeds, the `checkable` findings below
  // ("Check the label for gluten") are the exact ones this check just resolved — `match` itself
  // never changes, so showing them beside "Marked checked" below reads as contradictory until a
  // refresh. Drop only those; a finding the check never affects (already `listed`/blocked) keeps
  // showing.
  const displayFindings = state === "done"
    ? findings.filter((finding) => !finding.checkable) : findings;
  const mark = async () => {
    setState("saving");
    try {
      // finding #6: bind the check to the exact revision this card is showing, so a background
      // refresh that moved the active revision since cannot mark a label the user never read.
      // round 10 finding #2: bind the check to the allergen keys THIS card is showing right now —
      // never let the server re-derive them from whatever the account's profile has grown to by
      // the time the request arrives.
      const ok = await markAllergenChecked([match.foodRefId], true, {
        allergenKeys: findings.map((finding) => finding.allergen),
        expectedRevisions: { [match.foodRefId]: match.revisionId },
      });
      setState(ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="flex flex-col gap-1" aria-label="Allergens on this label">
      <AllergenFindingLines findings={displayFindings} />
      {checkable && state !== "done" && (
        <button type="button" onClick={mark} disabled={state === "saving"}
          className={`tap h-11 self-start px-1 ${META}`}>
          {state === "saving" ? "Saving" : "I checked the label"}
        </button>
      )}
      {state === "done" && <span role="status" className={META}>Marked checked for this product.</span>}
      {state === "failed" && <span role="status" className={META}>Could not save — try again</span>}
    </div>
  );
}
