import { removeExtra, updateExtra, upsertExtra } from "@/lib/store";
import type { LoggedFood, StoredDay } from "@/lib/types";

/** Where an entry's card is on this phone, skipping `except` (the day already looked at). */
export function findCard(
  days: Record<string, StoredDay>, entryId: string, except?: string,
): { date: string; card: LoggedFood } | null {
  for (const [date, day] of Object.entries(days)) {
    if (date === except) continue;
    const card = day.extras?.find((extra) => extra.id === entryId);
    if (card) return { date, card };
  }
  return null;
}

/** The card on `date`, or on another day when it was moved elsewhere while a write was pending. */
export function cardFor(days: Record<string, StoredDay>, entryId: string, date: string,
): { date: string; card: LoggedFood } | null {
  const here = days[date]?.extras?.find((extra) => extra.id === entryId);
  return here ? { date, card: here } : findCard(days, entryId, date);
}

/** Put the patched card on `date`, taking it off the day it was found on. */
export function placeCard(found: { date: string; card: LoggedFood }, date: string,
  patch: Partial<LoggedFood>): void {
  if (found.date === date) { updateExtra(date, found.card.id, patch); return; }
  removeExtra(found.date, found.card.id);
  upsertExtra(date, { ...found.card, ...patch });
}
