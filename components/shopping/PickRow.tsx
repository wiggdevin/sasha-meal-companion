"use client";

import { Check, Plus } from "lucide-react";
import RuleMark from "@/components/ui/RuleMark";
import { PICK_SOURCE_LABEL, type PickItem } from "@/lib/shopping/pick-sources";

/* The Favorites row's role dot (components/MyFoods.tsx): the macro gauge colours, never re-assigned. */
const DOT: Record<string, string> = {
  protein: "bg-[var(--color-gauge-protein)]",
  carb: "bg-[var(--color-gauge-carbs)]",
  fat: "bg-[var(--color-gauge-fat)]",
};

/**
 * One food to pick for the list (UI makeover W7 §7.1 item 4), laid out like a Favorites row: dot,
 * name, where it comes from, its rule mark, and a 44 px "+" that becomes ✓ "On list". A food off
 * the account's rules (`blocked`) shows its mark and cannot be added.
 */
export default function PickRow({ item, last, busy, onToggle }: {
  item: PickItem; last: boolean; busy: boolean; onToggle: (item: PickItem) => void;
}) {
  const blocked = item.ruleMark?.verdict === "blocked";
  // On the list but not removable here (a plan line or a bought item): shown as listed, inert.
  const locked = item.onList && !item.removable;
  const label = item.onList ? `Take ${item.name} off the list` : `Add ${item.name} to list`;
  return (
    <div className={`flex min-w-0 items-center gap-3 px-2.5 py-2.5 ${last ? "" : "border-b border-hairline"}`}
      data-pick-row={item.key}>
      <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${item.role ? DOT[item.role] : "border border-hairline"}`} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-medium">{item.name}</span>
        <span className="truncate text-tiny font-normal text-muted">{PICK_SOURCE_LABEL[item.source]}
          {item.onList ? " · On list" : ""}</span>
        <RuleMark mark={item.ruleMark} className="flex-wrap" />
      </span>
      {!blocked && <button type="button" aria-pressed={item.onList} aria-label={label}
        disabled={busy || locked}
        onClick={() => onToggle(item)}
        className={`tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
          item.onList ? "btn-primary" : "well text-charcoal"}`}>
        {item.onList ? <Check size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
      </button>}
    </div>
  );
}
