/**
 * Local-calendar helpers for the settings screen. Moved out of `app/settings/page.tsx`
 * (T9 §1) unchanged — the screen's own date maths, not the plan's.
 */

/** Local (not UTC) "yyyy-mm-dd" for today — see lib/plan.ts's own localDateOnly for why. */
export function todayIso(): string {
  return localIsoDate(new Date());
}

/** The device's LOCAL calendar day ("yyyy-mm-dd") for an instant — never its UTC date. */
export function localIsoDate(at: Date): string {
  const yyyy = at.getFullYear();
  const mm = String(at.getMonth() + 1).padStart(2, "0");
  const dd = String(at.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** `days` before `iso`, as a local yyyy-mm-dd — same local-date reasoning as todayIso() above. */
export function isoDaysBefore(iso: string, days: number): string {
  const [yyyy, mm, dd] = iso.split("-").map(Number);
  const date = new Date(yyyy, mm - 1, dd);
  date.setDate(date.getDate() - days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The LOCAL calendar day ("yyyy-mm-dd") an ISO timestamp falls on — never its UTC date. */
export function localIsoDay(isoTimestamp: string): string {
  return localIsoDate(new Date(isoTimestamp));
}

/** True when an ISO timestamp falls on the same LOCAL calendar day as `isoDate`. */
export function isSameLocalDay(isoTimestamp: string, isoDate: string): boolean {
  return localIsoDay(isoTimestamp) === isoDate;
}

export function formatKcal(n: number): string {
  return n.toLocaleString("en-US");
}
