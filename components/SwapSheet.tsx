"use client";

import type { Meal, SlotId } from "@/lib/types";
import { SLOT_LABELS } from "@/lib/meals";
import Sheet from "@/components/Sheet";
import { MacroLine } from "@/components/nutrition/MacroText";

/* Rows are ivory cards with a hairline (E0: no shadow inside the meal card); the picked row takes
   the olive ring, as a chosen suggestion card does. The list grows with its options and never
   scrolls inside (DESIGN.md §Layout, scroll ownership): the page scrolls. */
const ROW = "tap flex w-full flex-col gap-0.5 rounded-2xl border bg-surface px-3.5 py-3 text-left";
const ROW_PICKED = "border-primary outline-2 -outline-offset-2 outline-primary";
const ROW_IDLE = "border-hairline";

/**
 * The other options for a slot that has an authored set (a non-meal slot). PRD §7.3 — swapping
 * never changes the day's macro targets, so every option shown here carries identical macros; only
 * the food differs.
 */
export default function SwapSheet({
  slot,
  options,
  currentMealId,
  isDefaultPick,
  onSelect,
  onUseRotation,
  onClose,
}: {
  slot: SlotId;
  options: Meal[];
  currentMealId: string;
  isDefaultPick: boolean;
  onSelect: (mealId: string) => void;
  onUseRotation: () => void;
  onClose: () => void;
}) {
  return <Sheet title={`Swap ${SLOT_LABELS[slot]}`} inset={{ label: "Swap" }}
    subtitle="Same targets either way — pick whatever’s in the kitchen." onClose={onClose}>
    <div className="flex flex-col gap-2">
      <button type="button" onClick={onUseRotation} aria-pressed={isDefaultPick}
        className={`${ROW} ${isDefaultPick ? ROW_PICKED : ROW_IDLE}`}>
        <span className="text-caption text-charcoal">Today&apos;s pick</span>
      </button>
      {options.map((option) => {
        const active = !isDefaultPick && option.id === currentMealId;
        return <button key={option.id} type="button" onClick={() => onSelect(option.id)} aria-pressed={active}
          className={`${ROW} ${active ? ROW_PICKED : ROW_IDLE}`}>
          <span className="text-caption text-charcoal">{option.name}</span>
          <span className="text-tiny tabular-nums text-muted"><MacroLine values={option.macros} /></span>
        </button>;
      })}
    </div>
  </Sheet>;
}
