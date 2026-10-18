"use client";

import { useId, useState } from "react";
import { Check, MoreHorizontal, X } from "lucide-react";
import { DisclosurePanel } from "@/components/ui/Disclosure";
import ShoppingLineCard, { type ShoppingLinePatch } from "@/components/ShoppingLineCard";
import RuleMark from "@/components/ui/RuleMark";
import { RULE_MARK_LABEL, ruleMarkReason } from "@/lib/rule-mark";
import { displayAmount } from "@/lib/recipes/preview-display";
import type { ShoppingLine } from "@/lib/shopping/types";

/** "400 g · for 3 meals · ripe ones": what the row says under the item's name. */
export function rowMeta(line: ShoppingLine): string | null {
  const grams = line.buyGrams ?? line.needGrams;
  const meals = new Set(line.sources.map((source) => `${source.localDate}:${source.slotId}`)).size;
  const parts = [
    grams === null ? null : `${displayAmount(grams)} g`,
    meals === 0 ? null : `for ${meals} meal${meals === 1 ? "" : "s"}`,
    line.note,
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * One item on the list (2026-10-02): the whole row ticks it off, a round check shows it, and the
 * full editor (name, note, stock, plan pin) opens below it on demand. A manual item can be removed.
 * A line marked against the account's food rules carries the short tag on its second line; the
 * checkbox's name says the verdict and reason once, and the editor shows the sentence. The mark never
 * hides the line.
 */
export default function ShoppingRow({ line, checked, busy = false, byWeek = false, onToggle, onDelete, onPatch,
  onConfirmPantry, selected, onSelectedChange }: {
  line: ShoppingLine; checked: boolean; busy?: boolean;
  /** A monthly list's plan item: ticked week by week below, so the row says so and is not a checkbox. */
  byWeek?: boolean;
  onToggle: () => void; onDelete?: () => void;
  onPatch?: (line: ShoppingLine, patch: ShoppingLinePatch) => Promise<void>;
  onConfirmPantry?: (line: ShoppingLine, grams: number) => Promise<void>;
  selected?: boolean; onSelectedChange?: (selected: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = `${useId().replace(/:/g, "")}-details`;
  const meta = rowMeta(line);
  const mark = line.ruleMark ?? null;
  const markLabel = mark ? `. ${RULE_MARK_LABEL[mark.verdict]}: ${ruleMarkReason(mark)}` : "";
  const status = byWeek ? (checked ? "Bought this week" : "Tick by week below") : null;
  const details = [status, meta].filter(Boolean).join(" · ");
  const body = <>
    <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
      checked ? "btn-primary" : "well"}`}>{checked && <Check size={15} strokeWidth={2.4} />}</span>
    <span className="flex min-w-0 flex-col">
      <span className={`truncate text-[16px] ${checked ? "text-muted line-through" : "font-medium text-charcoal"}`}>
        {line.name}</span>
      {(details || mark) && <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <RuleMark mark={mark} variant="tag" />
        {details && <span className="min-w-0 truncate text-tiny text-muted">{details}</span>}
      </span>}
    </span>
  </>;
  return <li className="flex flex-col">
    <div className="flex min-h-12 items-center gap-1">
      {byWeek ? <div className="flex min-h-12 min-w-0 flex-1 items-center gap-3 pr-2">{body}</div>
        : <button type="button" role="checkbox" aria-checked={checked} disabled={busy}
          aria-label={`${line.name}, ${checked ? "in cart" : "to buy"}${markLabel}`}
          onClick={onToggle}
          className="tap flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-2xl pr-2 text-left">{body}</button>}
      <button type="button" aria-expanded={open} aria-controls={panelId} aria-label={`Details for ${line.name}`}
        onClick={() => setOpen((value) => !value)}
        className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted">
        <MoreHorizontal size={18} aria-hidden="true" /></button>
      {onDelete && <button type="button" aria-label={`Remove ${line.name}`} disabled={busy} onClick={onDelete}
        className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted">
        <X size={18} aria-hidden="true" /></button>}
    </div>
    <DisclosurePanel id={panelId} open={open} keepMounted={false} className="pb-2 pl-9">
      <ShoppingLineCard line={line} showBought={false}
        selected={selected} onSelectedChange={onSelectedChange} onPatch={onPatch}
        onConfirmPantry={onConfirmPantry} /></DisclosurePanel>
  </li>;
}
