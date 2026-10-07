/**
 * The Today stack: the plan and everything the user logged on top of it, in one list.
 *
 * The plan is the plan — its slots keep their planned times and their order. But the user will snack,
 * miss a meal, or eat something at 3pm that was never on it, and those used to land in a separate
 * "Also today" pile at the bottom of the page, away from the day they belong to. A logged entry
 * slots into the stack at the time it was logged instead, so the page reads as one day in order.
 *
 * Pure: no React, no store, no clock. The caller owns both lists.
 */
import type { LoggedFood, ResolvedSlot } from "@/lib/types";

export type TimelineItem =
  | { kind: "slot"; key: string; minutes: number; slot: ResolvedSlot }
  | { kind: "extra"; key: string; minutes: number; entry: LoggedFood };

/** "08:30" -> 510. An unparseable time sorts to midnight, which is where an unset slot belongs. */
export function slotMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
}

/**
 * Minutes past LOCAL midnight for a logged entry's ISO timestamp, or null when it cannot be read.
 * Local, not UTC: the stack is ordered by the clock the user ate against, and `resolveDay` has already
 * decided the entry belongs to this date.
 */
export function entryMinutes(at: string): number | null {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getHours() * 60 + parsed.getMinutes();
}

/**
 * One clock-ordered stack. A plan slot and a logged entry at the same minute put the plan first —
 * the plan is the spine of the day and the log is what happened against it. An entry whose
 * timestamp will not parse goes to the end rather than jumping to midnight, where it would claim
 * to be the first thing the user ate.
 */
export function mergeTimeline(slots: ResolvedSlot[], extras: LoggedFood[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...slots.map((slot): TimelineItem => ({
      kind: "slot", key: `slot-${slot.slot}`, minutes: slotMinutes(slot.time), slot,
    })),
    ...extras.map((entry): TimelineItem => ({
      kind: "extra",
      key: `extra-${entry.id}`,
      minutes: entryMinutes(entry.at) ?? Number.MAX_SAFE_INTEGER,
      entry,
    })),
  ];
  const rank = (item: TimelineItem) => (item.kind === "slot" ? 0 : 1);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      a.item.minutes - b.item.minutes ||
      rank(a.item) - rank(b.item) ||
      a.index - b.index)
    .map(({ item }) => item);
}
