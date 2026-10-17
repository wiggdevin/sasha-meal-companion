/**
 * W142: the gentle check before "I logged everything I ate today" (docs/plans/2026-10-04-jev-
 * opportunities.md §2). Jev reads four counts and two hours about the viewed day, never a name, a
 * note or a health field, and answers one yes/no question. Above the threshold the control asks
 * once before marking; the mark itself stays the user's statement (ruling R3) and nothing here ever
 * blocks it. Copy never tells anyone to eat.
 */
import { noul } from "@/lib/ai/jev-types";
import type { StoredDay } from "@/lib/types";

/** The nudge shows only when Jev's probability that the log is missing a meal is above this. */
export const DAY_COMPLETENESS_THRESHOLD = 0.8;

export const DAY_INCOMPLETE_QUESTION = noul(
  "Judging only from these counts and hours, does this day's food log probably leave out a normal meal or more?",
  {
    true: "The log looks short for this point in the day, or for a whole day, and a meal or more was likely not recorded.",
    false: "The log looks plausible as a complete record of what was eaten, even if the day was light.",
  },
);

/** All Jev sees about the day: counts and clock hours only. */
export type DayCompletenessState = {
  isToday: boolean;
  /** The phone's clock hour (0-23), only for today; null for an earlier day. */
  localHour: number | null;
  /** Plan meals ticked eaten. */
  mealsEaten: number;
  /** Foods and meals logged outside the plan's meal slots. */
  entryCount: number;
  /** The clock hour of the latest ticked meal, when one is known. */
  lastEntryHour: number | null;
};

const hourOf = (iso: string): number | null => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.getHours();
};

export function dayCompletenessState(
  day: StoredDay | undefined, date: string, today: string, now: Date = new Date(),
): DayCompletenessState {
  const stamps = Object.values(day?.eaten ?? {}).filter((stamp): stamp is string => Boolean(stamp));
  const hours = stamps.map(hourOf).filter((hour): hour is number => hour !== null);
  const isToday = date === today;
  return {
    isToday,
    localHour: isToday ? now.getHours() : null,
    mealsEaten: stamps.length,
    entryCount: Math.min(day?.extras?.length ?? 0, 100),
    lastEntryHour: hours.length > 0 ? Math.max(...hours) : null,
  };
}

/** The shown copy: a question about the log, never about eating. */
export const DAY_NUDGE_TITLE = "This day may be missing a meal.";
export const DAY_NUDGE_BODY = "Mark it fully logged anyway?";
