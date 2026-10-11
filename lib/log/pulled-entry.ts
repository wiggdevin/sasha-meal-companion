/**
 * A `log_entries` row pulled from the server, put on Today.
 *
 * The pull mirrors every row into IndexedDB, but Today and the rings read the day's `extras`
 * (lib/resolve.ts). Before this, only a delete reached them (`dropDeletedEntry`), so an entry
 * another device logged or edited never showed on this phone's card (W011 follow-up, PR #59).
 *
 * The rules are the read-back's (lib/log/reconcile.ts): a row only moves a card FORWARD
 * (`canPatchCard`), and the card's own words stay where the row has none (`entryPatchFromRow`).
 * A row for a date other than the card's moves the card. An entry with no card anywhere gets one
 * built from the row: its items are the row's numbers and their macros come from the snapshots,
 * the way every card's totals do.
 */
import { isCompleteEntryRow } from "@/lib/log/entry-row";
import { rowNutritionPartial } from "@/lib/log/partial-mark";
import { canPatchCard, entryPatchFromRow } from "@/lib/log/reconcile";
import { findCard } from "@/lib/log/card-find";
import type { LoggedFood, StoredDay } from "@/lib/types";

type Days = Record<string, StoredDay>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The day the row belongs to, or null when the row cannot say. */
function rowDate(row: Record<string, unknown>): string | null {
  return typeof row.local_date === "string" && ISO_DATE.test(row.local_date) ? row.local_date : null;
}

/** A card for an entry this phone has never seen: the row's own numbers, nothing invented. */
function blankCard(entryId: string, row: Record<string, unknown>): LoggedFood {
  const items = Array.isArray(row.items) ? row.items.length : 0;
  return {
    id: entryId, foodId: "meal",
    name: "Logged meal",
    portionLabel: `${items} item${items === 1 ? "" : "s"}`,
    qty: 1, grams: 0,
    macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    items: [],
    at: typeof row.eaten_at === "string" ? row.eaten_at : new Date(0).toISOString(),
  };
}

function withExtras(days: Days, date: string, extras: LoggedFood[]): Days {
  const day = days[date] ?? { date };
  return { ...days, [date]: { ...day, extras } };
}

/**
 * The days with the pulled row projected onto them. Returns the same object when nothing changes,
 * so the caller can skip the write.
 *
 * `mirrorRev` is the revision the mirror held BEFORE this row: a card with no revision of its own
 * is judged against it, as the read-back does. A row too thin to describe its items (no complete
 * items) is left to the mirror: a card built from it would read as a measured zero.
 */
export function projectPulledEntry(
  days: Days, entryId: string, row: Record<string, unknown>, mirrorRev: number | null = null,
): Days {
  const date = rowDate(row);
  if (date === null || !isCompleteEntryRow(row)) return days;
  const held = findCard(days, entryId);
  const incoming = typeof row.rev === "number" ? row.rev : null;
  const heldRev = held && typeof held.card.rev === "number" ? held.card.rev : null;
  if (held && !canPatchCard(incoming, heldRev, mirrorRev)) return days;
  const base = held?.card ?? blankCard(entryId, row);
  const card: LoggedFood = { ...base, ...entryPatchFromRow(base, row) };
  // The row's own record of a partly measured item sets or clears the mark; unknown leaves it.
  const partial = rowNutritionPartial(row, null);
  if (partial !== null) card.nutritionPartial = partial || undefined;
  if (typeof row.eaten_at === "string") card.at = row.eaten_at;
  let next = days;
  if (held && held.date !== date) {
    next = withExtras(next, held.date, (next[held.date]?.extras ?? []).filter((e) => e.id !== entryId));
  }
  const extras = next[date]?.extras ?? [];
  const present = extras.some((extra) => extra.id === entryId);
  return withExtras(next, date, present
    ? extras.map((extra) => (extra.id === entryId ? card : extra))
    : [...extras, card]);
}
