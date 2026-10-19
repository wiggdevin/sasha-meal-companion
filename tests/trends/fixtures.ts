import type { TrendDay } from "@/lib/trends/series";
import { isoShift, weekdayShort } from "@/lib/trends/series";

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** A plain day with nothing recorded. */
export function blankDay(date: string, over: Partial<TrendDay> = {}): TrendDay {
  return { date, weekday: WEEKDAY[weekdayShort(date)], today: false, dayType: "rest", kcal: null, protein: null,
    intakePartial: false, kcalTarget: null, proteinTarget: null, fullyLogged: false, cups: null, waterGoal: null,
    sleepMin: null, activeKcal: null, steps: null, weightKg: null, ...over };
}

/** `n` days ending on `end` (the last is today), each shaped by `shape(index, date)`. */
export function trendDays(end: string, n: number, shape: (i: number, date: string) => Partial<TrendDay>): TrendDay[] {
  return Array.from({ length: n }, (_, i) => {
    const date = isoShift(end, i - (n - 1));
    return blankDay(date, { today: i === n - 1, ...shape(i, date) });
  });
}
