/**
 * T11b: one fetch serves two windows on `/body`. The TDEE lines need the latest weigh-in inside
 * 14 days plus 7 days of active energy, so the fetch spans 15 days ending at today; the sparklines
 * stay a 7-day read (the chart the design contract describes). Slicing the chart here — not by
 * shrinking the fetch — is what keeps a weigh-in 8–14 days old feeding the formula line
 * (Sol audit finding 5).
 */

/** Inclusive days in the TDEE fetch window: today plus the 14 days the weight rule looks back. */
export const TDEE_WINDOW_DAYS = 15;

/** Days the sparklines plot, taken from the newest end of the same fetch. */
export const CHART_WINDOW_DAYS = 7;

/** The newest `CHART_WINDOW_DAYS` of a series, oldest first — what a sparkline should draw. */
export function chartDays<T>(days: readonly T[]): T[] {
  return days.slice(-CHART_WINDOW_DAYS);
}
