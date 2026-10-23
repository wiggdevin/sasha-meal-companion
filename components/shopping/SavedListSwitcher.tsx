"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { compactRange, listName, progressLine } from "@/lib/shopping/saved-lists";
import type { ShoppingPeriod } from "@/lib/shopping/types";

/**
 * The saved-list switcher at the top of Shopping (UI makeover W7 §7.1 item 2): `‹ Weekly shop ›`
 * over "20–26 Oct · 12 items · 3 in cart". The 44 px arrows walk the lists newest first;
 * the title opens the saved lists sheet (new, rename, delete).
 */
export default function SavedListSwitcher({ period, count, itemCount, checkedCount, onStep, onOpenLists,
  hasNewer, hasOlder }: {
  /** The open list, or null while none is saved yet. */
  period: Pick<ShoppingPeriod, "id" | "title" | "startDate" | "endDate"> | null;
  /** How many saved lists there are. */
  count: number;
  itemCount: number;
  checkedCount: number;
  onStep: (step: 1 | -1) => void;
  /** Whether a newer (‹) or older (›) list exists. */
  hasNewer: boolean;
  hasOlder: boolean;
  onOpenLists: () => void;
}) {
  const name = period ? listName(period) : "New list";
  const arrow = "tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-charcoal disabled:opacity-40";
  return (
    <nav aria-label="Saved lists" className="flex min-w-0 items-center gap-1">
      <button type="button" className={arrow} disabled={!hasNewer} onClick={() => onStep(-1)}
        aria-label="Newer list"><ChevronLeft size={22} aria-hidden="true" /></button>
      <button type="button" onClick={onOpenLists} aria-haspopup="dialog"
        aria-label={`${name}. Open your saved lists`}
        className="tap flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center rounded-2xl px-2 text-center">
        <span className="w-full truncate text-title text-charcoal">{name}</span>
        <span className="w-full truncate text-tiny text-muted">
          {period ? `${compactRange(period.startDate, period.endDate)} · ${progressLine(itemCount, checkedCount)}`
            : count === 0 ? "Nothing saved yet" : `${count} saved ${count === 1 ? "list" : "lists"}`}
        </span>
      </button>
      <button type="button" className={arrow} disabled={!hasOlder} onClick={() => onStep(1)}
        aria-label="Older list"><ChevronRight size={22} aria-hidden="true" /></button>
    </nav>
  );
}
