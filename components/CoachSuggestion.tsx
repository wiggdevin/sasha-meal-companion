"use client";

/**
 * One suggestion card per CoachSuggestion. The verdict is computed on the server; this component
 * only renders it. "Log this" appears on `allowed` alone, and a blocked suggestion never carries
 * a draft, so there is nothing for it to open (acceptance criterion 6).
 *
 * Amber pill for unverified is F-078; amber is the DESIGN.md gauge-fat gold #c9a24a / #b8892e,
 * the one warning colour in the palette. No new colours.
 */

import Button from "@/components/ui/Button";
import type { CoachSuggestion as Suggestion } from "@/lib/coach/types";
import Disclosure from "@/components/ui/Disclosure";
import { reasonLabel } from "@/lib/policy/reason-words";

/** "allergen:dairy" and "facet:meat" are machine reasons; the user reads plain words. */
function reasonText(reason: string): string {
  return reasonLabel(reason, reason);
}

export default function CoachSuggestion({
  suggestion, onLog,
}: { suggestion: Suggestion; onLog?: () => void }) {
  const blocked = suggestion.verdict === "blocked";
  return (
    <div className="shell rounded-2xl!">
      <div className="surface flex items-center gap-3 rounded-2xl! px-3.5 py-3">
        <span className={`min-w-0 flex-1 truncate text-caption font-normal ${blocked ? "text-muted line-through" : "text-charcoal"}`}>
          {suggestion.name}
          {suggestion.grams !== null && (
            <span className="font-normal text-muted"> · {suggestion.grams} g</span>
          )}
        </span>

        {suggestion.verdict === "unverified" && (
          <Disclosure variant="row" size="sm" className="shrink-0 text-right"
            title={<span className="pill-in flex h-[30px] items-center px-2.5 text-tiny font-normal text-warning">Unverified</span>}
            bodyClassName="max-w-48 pt-1 text-left text-tiny text-muted">
            Could not verify this food against your food rules. This says nothing about its nutrition or taste.
          </Disclosure>
        )}

        {blocked && (
          <span className="shrink-0 text-tiny font-normal text-muted">
            {reasonText(suggestion.reason ?? "blocked")}
          </span>
        )}

        {suggestion.verdict === "allowed" && onLog && (
          <Button variant="secondary" size="sm" onClick={onLog}>Log this</Button>
        )}
      </div>
    </div>
  );
}
