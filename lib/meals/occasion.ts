/**
 * Which meal a slot is, read off its clock (Phase 17 O1, docs/specs/phase-17-meal-occasion.md).
 *
 * ONE set of clock bands for the whole app. Before this, the coach (lib/coach/meal-type.ts) and
 * the meal-plan document matcher (lib/plan/document-clean.ts) each had a copy, and they disagreed
 * at 10:30–11:00, 14:30–15:00 and overnight. Both now read these bands.
 *
 * Each band starts at its first minute and ends before the next band's:
 *   breakfast 04:00–10:29 · lunch 10:30–14:59 · snack 15:00–16:59 · dinner 17:00–22:00
 *   (22:00 itself is still dinner) · "other" overnight, 22:01–03:59.
 * An overnight slot (a 02:00 meal on a night shift) is "other", not a snack: it is a real meal
 * whose occasion the clock cannot tell, so it gets the savoury-main template and a neutral
 * affinity for every anchor (lib/meals/templates.ts, lib/meals/affinity.ts).
 *
 * A slot id ("meal-1") says nothing about the time of day; the clock decides, unless the account
 * set an override for that slot ("Meal 2 is my breakfast"), which always wins.
 *
 * Pure. No I/O.
 */

export type Occasion = "breakfast" | "lunch" | "dinner" | "snack" | "other";

export const OCCASIONS: readonly Occasion[] = ["breakfast", "lunch", "dinner", "snack", "other"];

/** Per-slot occasion the account chose; the key is the slot id ("meal-2"). */
export type OccasionOverrides = Readonly<Partial<Record<string, Occasion>>>;

export const OCCASION_BANDS: readonly { occasion: Occasion; from: number; to: number }[] = [
  { occasion: "breakfast", from: 4 * 60, to: 10 * 60 + 30 },
  { occasion: "lunch", from: 10 * 60 + 30, to: 15 * 60 },
  { occasion: "snack", from: 15 * 60, to: 17 * 60 },
  // The last band's end is inclusive: a 22:00 dinner is dinner.
  { occasion: "dinner", from: 17 * 60, to: 22 * 60 + 1 },
];

const CLOCK = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i;

/** Minutes after midnight for "07:30", "7:30 AM", "19:05" or "7 pm"; null when unreadable. */
export function clockMinutes(clock: string | null | undefined): number | null {
  if (!clock) return null;
  const match = CLOCK.exec(clock);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const half = match[3]?.toLowerCase();
  if (minute > 59 || hour > 23 || (half && (hour < 1 || hour > 12))) return null;
  if (half === "p" && hour < 12) hour += 12;
  if (half === "a" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/** "07:30" for display and for the ranking question; null when unreadable. */
export function clockLabel(clock: string | null | undefined): string | null {
  const minutes = clockMinutes(clock);
  if (minutes === null) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * The occasion of a slot: the account's override for that slot when it set one, else the band
 * its clock falls in, else "other" (no readable clock).
 */
export function occasionAt(
  clock: string | null | undefined,
  options: { slot?: string | null; overrides?: OccasionOverrides } = {},
): Occasion {
  const chosen = options.slot ? options.overrides?.[options.slot] : undefined;
  if (chosen) return chosen;
  const minutes = clockMinutes(clock);
  if (minutes === null) return "other";
  return OCCASION_BANDS.find((band) => minutes >= band.from && minutes < band.to)?.occasion ?? "other";
}

/** Whether the time of a slot is unknown: "other" with no readable clock (not overnight). */
export function isUntimed(occasion: Occasion, clock: string | null | undefined): boolean {
  return occasion === "other" && clockMinutes(clock) === null;
}
