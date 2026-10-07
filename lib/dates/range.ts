const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function instantOf(date: string): Date | null {
  const match = LOCAL_DATE.exec(date);
  if (!match) return null;
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return instant.toISOString().slice(0, 10) === date ? instant : null;
}

function isoDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** Plain-date arithmetic: elapsed hours and DST never participate. */
export function shiftCalendarDate(date: string, days: number): string {
  const instant = instantOf(date);
  if (!instant) throw new Error("date must be YYYY-MM-DD");
  instant.setUTCDate(instant.getUTCDate() + days);
  return isoDate(instant);
}

export type CalendarRange =
  | { ok: true; dates: string[] }
  | { ok: false; reason: "invalid" | "reversed" | "too_long" };

/** Expand civil date labels inclusively, applying the cap before weekday filtering.
 * Weekdays of YYYY-MM-DD labels are timezone-independent; the caller already chose those labels in
 * the request timezone, so this path deliberately does not accept or reinterpret a timezone. */
export function calendarDateRange(
  from: string,
  through: string,
  weekdays: readonly number[] | undefined,
  cap = 31,
): CalendarRange {
  const first = instantOf(from);
  const last = instantOf(through);
  if (!first || !last) return { ok: false, reason: "invalid" };
  const span = Math.floor((last.getTime() - first.getTime()) / 86_400_000) + 1;
  if (span < 1) return { ok: false, reason: "reversed" };
  if (span > cap) return { ok: false, reason: "too_long" };
  const allowed = weekdays ? new Set(weekdays) : null;
  const dates = Array.from({ length: span }, (_, offset) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + offset);
    return { label: isoDate(date), weekday: date.getUTCDay() };
  }).filter(({ weekday }) => allowed === null || allowed.has(weekday))
    .map(({ label }) => label);
  return { ok: true, dates };
}
