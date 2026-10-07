/**
 * An item's mass may be unknown (t17 gap 1, migration 20261211090000): a unit of a food with no
 * known unit weight stores `grams: null` with its `qty` and `unit`. These are the two questions
 * every reader asks of such an item, answered once so none of them turns null into 0 or NaN.
 *
 * Pure. No I/O.
 */
import type { LoggedFood, LoggedItem } from "@/lib/types";

type Amount = { grams: number | null | undefined; qty: number; unit: string };

/** A stored mass, or null when it is unknown. Anything not a finite number >= 0 is unknown. */
export function massOf(grams: unknown): number | null {
  if (grams === null || grams === undefined || grams === "") return null;
  const n = typeof grams === "number" ? grams : Number(grams);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The entry's mass from its items: the sum of the known ones, and whether any is unknown. A
 * caller that shows or exports a total must show `massUnknown`, never the partial sum alone.
 */
export function entryMass(items: readonly { grams: number | null | undefined }[]): {
  grams: number; massUnknown: boolean;
} {
  let grams = 0;
  let massUnknown = false;
  for (const item of items) {
    const mass = massOf(item.grams);
    if (mass === null) massUnknown = true;
    else grams += mass;
  }
  return { grams, massUnknown };
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * "140 g", or for an unknown mass its count: "2 pouch". A count in grams with no mass says nothing
 * true either way (the contract refuses it), so it reads "mass unknown", never "100 g".
 */
export function amountLabel(item: Amount): string {
  const mass = massOf(item.grams);
  if (mass !== null) return `${fmt(mass)} g`;
  return item.unit === "g" ? "mass unknown" : `${fmt(item.qty)} ${item.unit}`;
}

/**
 * An item the server now says has an unknown mass, where the card still holds a known one: its
 * label ("100 g") no longer says what was logged, so it becomes the count ("2 pouch"). Any other
 * item keeps its own words.
 */
export function relabelLostMass<T extends LoggedItem>(previous: { grams: number | null } | undefined,
  next: T): T {
  return next.grams === null && massOf(previous?.grams) !== null
    ? { ...next, portionLabel: amountLabel(next) } : next;
}

/**
 * The card fields that follow its items' masses once a reconcile has moved them (t17 round 4,
 * GPT-6 WARN 3): the known mass, `massUnknown`, and — for a one-food card — its amount label.
 * Nothing changes for a card whose items were and stay all known: its grams and words are the
 * sheet's, and this rule is only about an unknown mass appearing or going.
 */
export function cardMassPatch(entry: LoggedFood, items: readonly LoggedItem[]): Partial<LoggedFood> {
  const { grams, massUnknown } = entryMass(items);
  if (!massUnknown && entry.massUnknown !== true) return {};
  const single = entry.foodId !== "meal" && items.length === 1;
  // The words move only when the mass went unknown or came back: a card that was already a count
  // keeps the sheet's own label.
  const relabel = single && massUnknown !== (entry.massUnknown === true);
  return {
    grams: single ? grams : Math.round(grams),
    // `undefined` (not absent): the store merges a patch field by field, so the key must be sent
    // to take a stale mark off.
    massUnknown: massUnknown ? true : undefined,
    ...(relabel ? { portionLabel: amountLabel(items[0]) } : {}),
  };
}

/** The card's new items and the mass fields that follow them (`cardMassPatch`). */
export function withItemMass(entry: LoggedFood, items: LoggedItem[]): Partial<LoggedFood> {
  return { items, ...cardMassPatch(entry, items) };
}

/**
 * A card item brought up to the server's stored item: its grams and snapshot, and — for an unknown
 * mass, where the count IS the amount — its stored qty and unit, relabelled if its mass was lost.
 */
export function withServerAmount(item: LoggedItem, server: {
  grams: number | null; qty: number; unit: string; snapshot: LoggedItem["snapshot"];
}): LoggedItem {
  const amount = server.grams === null ? { qty: server.qty, unit: server.unit } : {};
  return relabelLostMass(item, { ...item, ...amount, grams: server.grams, snapshot: server.snapshot });
}
