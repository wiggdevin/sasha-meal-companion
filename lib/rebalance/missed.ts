/**
 * The one missed rule (Phase 19 §5.2). Pure. The panel is its only caller in v1; Today's card
 * renders no missed state.
 */
import { slotHasOwnLog } from "@/lib/plan/eaten-estimate";
import type { PanelSlot } from "@/lib/plan/panel-slots";
import type { ResolvedDay } from "@/lib/types";

/** The device's local day (`targetDayFor`) and minutes after local midnight. */
export type PanelNow = { date: string; minutes: number };

/** A tick is often late and timing is erratic; under the 150-minute meal spacing (D8). */
export const MISSED_GRACE_MINUTES = 90;

/** "08:30" → 510. */
export function clockToMinutes(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Today's own activity condition plus logged entries, so an untouched day never reads "missed":
 * a slot is eaten, the day is a floor day, a gut or weight entry is on it, or any entry is logged.
 */
export function dayHasActivity(day: ResolvedDay): boolean {
  return day.slots.some((slot) => slot.eaten) || day.isFloorDay || day.gut !== undefined
    || day.weightLb !== undefined || day.extras.length > 0;
}

/**
 * Missed: not eaten and not explicitly cleared; no log filed under it (the user acted on it); the
 * day has activity; and the day is past, or it is today and the grace after the slot's time is up.
 * An unplanned empty slot (`meal === null`, not cleared) stays eligible.
 */
export function isMissedSlot(slot: PanelSlot, day: ResolvedDay, now: PanelNow,
  graceMin = MISSED_GRACE_MINUTES): boolean {
  if (slot.eaten || slot.cleared) return false;
  if (slotHasOwnLog(day, slot.slot)) return false;
  if (!dayHasActivity(day)) return false;
  if (day.date < now.date) return true;
  return day.date === now.date && now.minutes >= clockToMinutes(slot.time) + graceMin;
}
