/**
 * The occasion a log entry was eaten at (Phase 17 O2, D1): the slot's clock on that local date,
 * read the way Today reads it, then `occasionAt`'s one set of bands.
 *
 *   1. the account's occasion override for the slot          → source "override"
 *   2. the per-day time edit for that slot (plan_days)       → source "slot_clock"
 *   3. the account's schedule for a meal slot (slot times,   → source "slot_clock"
 *      shift, meal count; `resolveSlotTimes`)
 *   4. an entry outside the schedule ("snack", a historical  → source "slot_clock", read off the
 *      ritual id, a meal beyond the meal count)                 time it was eaten in its own zone
 *
 * Pure. No I/O. The server stamps with it (lib/server/log-occasion.ts); the phone never needs to.
 */

import { resolveSlotTimes } from "@/lib/plan";
import { clockLabel, occasionAt, type Occasion, type OccasionOverrides } from "@/lib/meals/occasion";
import type { Settings, SlotId } from "@/lib/types";

export type LogOccasionSource = "slot_clock" | "override" | "user";

export type MealSchedule = {
  slotTimes: Readonly<Partial<Record<string, string>>>;
  shiftMinutes: number;
  mealsPerDay: number | null;
  /** The active revision's training calories: the meal count when the account chose none. */
  trainingKcal: number | null;
  overrides?: OccasionOverrides;
};

export type LoggedEntry = {
  slot: string;
  /** "HH:MM" the account set for this slot on this date (plan_days.item_overrides[slot].time). */
  dayTime?: string | null;
  eatenAt?: string | null;
  tz?: string | null;
};

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The scheduled clock of a meal slot, or null when the schedule has no such slot. The day type is
 * irrelevant: `resolveSlotTimes` builds the same slots and times for every day type (lib/plan.ts),
 * so "rest" is not a simplification.
 */
export function scheduledClock(schedule: MealSchedule, slot: string): string | null {
  try {
    const settings = {
      slotTimes: schedule.slotTimes as Settings["slotTimes"], shiftMinutes: schedule.shiftMinutes,
      mealsPerDay: schedule.mealsPerDay,
      activeTargetProfile: schedule.trainingKcal === null ? null
        : { training: { kcal: schedule.trainingKcal } } as unknown as Settings["activeTargetProfile"],
    };
    return resolveSlotTimes("rest", settings).find((row) => row.slot === (slot as SlotId))?.time ?? null;
  } catch {
    return null;
  }
}

/** "07:42" in the entry's own zone; null when the instant or the zone is unreadable. */
export function eatenClock(eatenAt: string | null | undefined, tz: string | null | undefined): string | null {
  if (!eatenAt) return null;
  const instant = new Date(eatenAt);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", hour: "2-digit",
      minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    // Some runtimes print midnight as hour "24" even with h23.
    return hour && minute ? clockLabel(`${hour === "24" ? "00" : hour}:${minute}`) : null;
  } catch {
    return null;
  }
}

/** The occasion an entry was eaten at, and why. */
export function entryOccasion(entry: LoggedEntry, schedule: MealSchedule):
  { occasion: Occasion; source: LogOccasionSource } {
  const chosen = schedule.overrides?.[entry.slot];
  if (chosen) return { occasion: chosen, source: "override" };
  const dayTime = entry.dayTime && CLOCK_TIME.test(entry.dayTime) ? entry.dayTime : null;
  const clock = dayTime ?? scheduledClock(schedule, entry.slot) ?? eatenClock(entry.eatenAt, entry.tz);
  return { occasion: occasionAt(clock), source: "slot_clock" };
}
