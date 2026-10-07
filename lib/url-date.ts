/**
 * The only place a URL is allowed to name a date. The Week tab links to
 * `/?d=YYYY-MM-DD`; the Today screen reads that back on mount. Anything that
 * is not a real calendar date falls back to today, so a hand-typed or stale
 * link can never blank the screen or land on a day that does not exist.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A strict `YYYY-MM-DD` in, the same string out — or null. Malformed input
 * ("2026-9-8", "20260908") and impossible dates ("2026-02-30") both fail;
 * the round-trip through `Date` is what catches the latter (and the two-digit
 * year trap, where `new Date(0, 0, 1)` silently means 1900).
 */
export function parseUrlDate(value: string | null | undefined): string | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return value;
}

/**
 * Which day the Today screen opens on, given a location search string and
 * today's date. A valid `?d=` wins; a missing or invalid one keeps today.
 */
export function viewedDateFromSearch(search: string, today: string): string {
  return parseUrlDate(new URLSearchParams(search).get("d")) ?? today;
}
