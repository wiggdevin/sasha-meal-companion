"use client";

import { Fragment, useId, useState, type ReactNode } from "react";
import { DisclosureChevron, DisclosurePanel } from "@/components/ui/Disclosure";

/** The most rows (or chips) a Foods list shows before "Show all N". */
export const LIST_LIMIT = 6;

/** A card's own Add, drawn in the list's footer row. */
export type ListAdd = { label: string; onAdd: () => void };

/**
 * A list that shows its first six items, then a "Show all N" control that opens the rest in place on
 * the shared animated Disclosure (docs/design/KIT.md §7) and folds them back with "Show fewer".
 * Decision 2026-10-04 (the owner asked "expand or scroll?"): never a nested scroll area — it
 * fights the page's own scroll on a phone, and the owner dislikes scrollbars.
 *
 * `render` gets `last`: whether the item is the last one drawn in its run, so a divided list can
 * drop its final hairline (keep the 1 px, make it transparent, so nothing shifts when it changes).
 * `divided` draws the hairline above "Show fewer" once the rest is open.
 *
 * With `add`, the list ends in the card's footer row instead (U14, owner 2026-10-04: "we're wasting
 * way too much room with the show all … split down the middle the add portion, which can be on the
 * right side, and the left side can be the show expansion"): one 44 px row under a full-width
 * hairline, "Show all N" on the left and Add on the right, or Add alone while nothing is hidden.
 * `inset` pads the rows so the footer's hairline can still run edge to edge.
 */
export default function CappedList<T>({ items, keyOf, render, limit = LIST_LIMIT, className = "flex flex-col",
  divided = false, label, add, inset = "" }: {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T, at: { last: boolean }) => ReactNode;
  limit?: number;
  /** The head and the revealed rest each lay out with this (a column of rows, a wrap of chips). */
  className?: string;
  divided?: boolean;
  /** What the items are, for the toggle's accessible name ("Show all 9 Protein foods"). */
  label?: string;
  add?: ListAdd;
  /** Horizontal padding for the rows when the footer row spans the card. */
  inset?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = `${useId().replace(/:/g, "")}-more`;
  const head = items.slice(0, limit);
  const rest = items.slice(limit);
  const draw = (run: readonly T[], tail: boolean) => run.map((item, index) => (
    <Fragment key={keyOf(item)}>{render(item, { last: tail && index === run.length - 1 })}</Fragment>
  ));
  const toggle = rest.length > 0 ? (
    <button type="button" data-show-all aria-expanded={open} aria-controls={panelId}
      onClick={() => setOpen((value) => !value)}
      className={`tap flex min-h-11 w-full min-w-0 items-center justify-center gap-1.5 text-caption text-muted ${
        !add && divided && open ? "border-t border-hairline" : ""}`}>
      <span className="whitespace-nowrap">{open ? "Show fewer" : `Show all ${items.length}`}</span>
      {label && <span className="sr-only">{label}</span>}
      <DisclosureChevron open={open} size={16} />
    </button>
  ) : null;
  return (
    <div className="flex min-w-0 flex-col">
      <div className={inset || undefined}>
        {/* Closed, the footer's hairline is the head's last line; open, the head runs on into the rest. */}
        <div className={className}>{draw(head, rest.length === 0 || (add !== undefined && !open))}</div>
        {rest.length > 0 && (
          <DisclosurePanel id={panelId} open={open} className={className}>{draw(rest, true)}</DisclosurePanel>
        )}
      </div>
      {add ? <ListFooter toggle={toggle} add={add} /> : toggle}
    </div>
  );
}

/**
 * The one footer a Foods category card ends with (U14): a full-width hairline over a 44 px row.
 * "Show all N" holds the left half and Add the right, split by a hairline; with nothing to show,
 * Add takes the whole row. Add is the card's verb, so it is the olive ink and the heavier weight;
 * "Show all N" is muted navigation. Exported so an empty card ends the same way.
 */
export function ListFooter({ toggle = null, add }: { toggle?: ReactNode; add: ListAdd }) {
  return (
    <div data-list-footer data-split={toggle ? "true" : "false"}
      className={`grid min-h-11 border-t border-hairline ${toggle ? "grid-cols-2" : "grid-cols-1"}`}>
      {toggle}
      <button type="button" data-category-add aria-label={add.label} onClick={add.onAdd}
        className={`tap flex min-h-11 w-full items-center justify-center text-caption font-semibold text-primary ${
          toggle ? "border-l border-hairline" : ""}`}>
        Add
      </button>
    </div>
  );
}
