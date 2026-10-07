"use client";

import AllergenFindingLines from "@/components/coach/editors/AllergenFindingLines";
import type { ProposeResponse } from "@/lib/capture/types";

const META = "text-tiny font-normal text-muted";

/**
 * Phase 13 §5: what the scanned label says about each allergen the account avoids, right after
 * the label is read. Never "safe": "Contains sesame", "No egg listed on the label", "Check the
 * label for gluten", the pregnancy/tuna mercury note (§9 R1, finding #11: lib/server/capture.ts's
 * labelFoodOf now folds it into `allergenWarnings` the same way `evaluatePolicy` does for the
 * item's own verdict) — and, whenever anything is not listed, that labels need not warn about
 * cross-contact. Logging is never blocked by these lines.
 */
export default function LabelAllergenLines({ label }: {
  label: NonNullable<ProposeResponse["labelFood"]>;
}) {
  return (
    <div className="flex flex-col gap-1" aria-label="Allergens on this label">
      {label.ingredientsText && <span className={META}>{label.ingredientsText}</span>}
      <AllergenFindingLines findings={label.allergenWarnings ?? []} />
    </div>
  );
}
