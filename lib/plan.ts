/**
 * Pure date -> schedule logic. PRD §7.1, §7.4; targets.md §5.
 *
 * Nothing here reads or writes storage. Every function takes what it needs
 * as an argument and returns a value — no start date, no expiry (PRD §1.1).
 */

import type { DayType, SlotId, Settings } from "./types";

// -------------------------------------------------------- local date math

/**
 * Dates in this app are ISO "yyyy-mm-dd" calendar dates with no attached
 * time zone — they mean "this day", full stop. Parsing them with
 * `new Date("yyyy-mm-dd")` is a trap: that form is UTC midnight, and in any
 * timezone behind UTC it displays as the previous day. We parse the
 * components ourselves and build a LOCAL midnight Date instead.
 */
function localDateOnly(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

// -------------------------------------------------------------- day type

/**
 * A `dayTypeOverride` on a StoredDay always wins over the weekday default. Every training weekday
 * is `training-10`: Wednesday's fasted 7am session was the first client's own week, and no
 * account inherits it (onboarding v2 G6). `training-7-fasted` is read only from an override the
 * account itself saved on a date.
 */
export function dayTypeFor(
  date: string,
  override?: DayType,
  settings?: Partial<Pick<Settings, "trainingWeekdays">>,
): DayType {
  if (override) return override;
  const trainingWeekdays = settings?.trainingWeekdays;
  if (!trainingWeekdays?.length) return "rest";
  return trainingWeekdays.includes(localDateOnly(date).getDay()) ? "training-10" : "rest";
}

// ------------------------------------------------------------- slot list

const MEAL_IDS: SlotId[] = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"];
const LAYOUT_TIMES: Record<number, string[]> = {
  2: ["09:00", "18:00"],
  3: ["08:00", "12:30", "18:30"],
  4: ["08:00", "11:30", "15:00", "18:30"],
  5: ["07:30", "10:30", "13:30", "16:30", "19:30"],
  6: ["07:00", "09:30", "12:00", "14:30", "17:00", "19:30"],
};

/** A missing server revision cannot invent targets; it only supplies an empty three-card layout. */
export function mealCountFor(settings: Partial<Pick<Settings, "mealsPerDay" | "activeTargetProfile">>): number {
  const chosen = settings.mealsPerDay;
  if (Number.isInteger(chosen) && chosen! >= 2 && chosen! <= 6) return chosen!;
  const trainingKcal = settings.activeTargetProfile?.training?.kcal;
  return trainingKcal == null || trainingKcal <= 1800 ? 3 : trainingKcal <= 2600 ? 4 : 5;
}

export function slotListFor(_dayType: DayType, settings?: Pick<Settings, "mealsPerDay" | "activeTargetProfile">): SlotId[] {
  return MEAL_IDS.slice(0, settings ? mealCountFor(settings) : 3);
}

// ------------------------------------------------------------- slot times

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Shift a "HH:MM" time by a signed minute offset. Clamps to the same
 * calendar day [00:00, 23:59] rather than wrapping into the previous or
 * next day — an over-aggressive shift just hits the end of the day.
 */
export function shiftTime(time: string, shiftMinutes: number): string {
  const total = timeToMinutes(time) + shiftMinutes;
  const clamped = Math.min(23 * 60 + 59, Math.max(0, total));
  return minutesToTime(clamped);
}

export type ResolvedSlotTime = { slot: SlotId; time: string };

/**
 * Final slot times for a day type: base time -> `settings.slotTimes`
 * per-slot override -> `settings.shiftMinutes` whole-day offset on top.
 * PRD §7.4.
 */
export function resolveSlotTimes(
  dayType: DayType,
  settings: Pick<Settings, "slotTimes" | "shiftMinutes"> & Partial<Pick<Settings, "mealsPerDay" | "activeTargetProfile">>
): ResolvedSlotTime[] {
  const count = mealCountFor(settings);
  const slots = slotListFor(dayType, settings);
  const base = LAYOUT_TIMES[count];

  return slots.map((slot, index) => {
    const baseTime = settings.slotTimes[slot] ?? base[index];
    if (!baseTime) {
      throw new Error(`No base time configured for slot "${slot}" on day type "${dayType}"`);
    }
    const time = settings.shiftMinutes ? shiftTime(baseTime, settings.shiftMinutes) : baseTime;
    return { slot, time };
  });
}
