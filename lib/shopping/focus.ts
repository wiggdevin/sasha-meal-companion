/**
 * D7 shopping and pantry signals (Phase 18 W11, docs/specs/phase-18-open-world-foods.md §W11):
 * which shopping lines and pantry items currently count as evidence, the shopping-focus switch
 * itself, and the coverage score focus mode ranks plates by.
 *
 * Pure. No I/O — every caller passes the rows and the date to judge, never reads them itself.
 */
import { addDays, localDate } from "@/lib/recipes-hub/put-in-meal";
import type { FocusRanking } from "@/lib/meals/plate";
import type { PantryItem, ShoppingLine, ShoppingPeriod } from "@/lib/shopping/types";

/** D7 "Line time box": period end, plus this many days. */
export const LINE_BOX_EXTRA_DAYS = 3;
/** D7 "Line time box": at most this many days from the period's own start. */
export const LINE_BOX_MAX_DAYS = 21;
/** D7 "Pantry time box": this many days after `confirmedAt`. */
export const PANTRY_BOX_DAYS = 14;
/** D7 shopping focus: the default end when no period is open. */
export const FOCUS_DEFAULT_DAYS = 7;
/** D7 shopping focus: the farthest out an end date may be set. */
export const FOCUS_MAX_DAYS = 31;

/**
 * D7 "A used line": checked — the line itself, or one of its purchase windows
 * (`windowChecked`, a planner line ticked off window by window) — or `origin = 'manual'` (a line
 * the planner did not write, so there is no plan rank to train on it circularly). An unchecked
 * line the planner made, with no checked window, never counts.
 */
export function isUsedLine(line: Pick<ShoppingLine, "checked" | "origin">, windowChecked = false): boolean {
  return line.checked || windowChecked || line.origin === "manual";
}

/** D7 "Line time box": the period's `start_date` to its `end_date` plus 3 days, at most 21 days
 *  from that same start — whichever end comes first. */
export function lineBoxEnd(period: Pick<ShoppingPeriod, "startDate" | "endDate">): string {
  const extended = addDays(period.endDate, LINE_BOX_EXTRA_DAYS);
  const capped = addDays(period.startDate, LINE_BOX_MAX_DAYS);
  return extended < capped ? extended : capped;
}

/**
 * Whether a line counts as evidence/coverage on `date` (inclusive both ends; lines store no
 * check time, so the period's dates are the whole box, D7).
 */
export function lineActiveOn(
  line: Pick<ShoppingLine, "checked" | "origin">,
  period: Pick<ShoppingPeriod, "startDate" | "endDate">,
  date: string,
  windowChecked = false,
): boolean {
  return isUsedLine(line, windowChecked) && date >= period.startDate && date <= lineBoxEnd(period);
}

/**
 * D7 "Pantry time box": 14 days after `confirmedAt` (its own local date), inclusive both ends.
 * Confirming again restarts it (the caller reads the row's CURRENT `confirmedAt`, never a
 * history); deleting ends it at once (a deleted row is simply not in the caller's query).
 */
export function pantryActiveOn(item: Pick<PantryItem, "confirmedAt">, date: string, zone?: string | null): boolean {
  const confirmedDate = dateIn(item.confirmedAt, zone);
  return date >= confirmedDate && date <= addDays(confirmedDate, PANTRY_BOX_DAYS);
}

/** The calendar date an instant falls on in `zone` (an IANA name); the device's own zone without one. */
export function dateIn(instant: string, zone?: string | null): string {
  const at = new Date(instant);
  if (!Number.isFinite(at.getTime())) return instant.slice(0, 10);
  if (!zone) return localDate(at);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit",
      day: "2-digit" }).format(at);
  } catch { return localDate(at); }
}

/** Milliseconds `zone` is ahead of UTC at `ms`. */
function zoneOffsetMs(ms: number, zone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The last millisecond of local `date` in `zone` (UTC when the zone is missing or unknown). */
export function endOfLocalDay(date: string, zone?: string | null): string {
  const midnightUtc = Date.parse(`${addDays(date, 1)}T00:00:00Z`);
  let at = midnightUtc;
  if (zone) {
    try {
      at = midnightUtc - zoneOffsetMs(midnightUtc, zone);
      at = midnightUtc - zoneOffsetMs(at, zone);
    } catch { at = midnightUtc; }
  }
  return new Date(at - 1).toISOString();
}

/** D7 "Shopping focus": `null`/undefined or a past `until` is off — no separate boolean. */
export function shoppingFocusActive(until: string | null | undefined, now: Date): boolean {
  return typeof until === "string" && Number.isFinite(Date.parse(until)) && Date.parse(until) > now.getTime();
}

/** The default end when the account turns focus on with no explicit date: the open shopping
 *  period's end (through its last moment in the account's zone), or FOCUS_DEFAULT_DAYS out with
 *  none open. */
export function defaultFocusEnd(now: Date, openPeriodEndDate: string | null, zone?: string | null): string {
  if (openPeriodEndDate) return endOfLocalDay(openPeriodEndDate, zone ?? "UTC");
  return new Date(now.getTime() + FOCUS_DEFAULT_DAYS * 86_400_000).toISOString();
}

/** The farthest a requested end date may sit from `now` (D7's stated maximum). */
export function maxFocusEnd(now: Date): string {
  return new Date(now.getTime() + FOCUS_MAX_DAYS * 86_400_000).toISOString();
}

/**
 * D7 "Coverage is the share of plate calories from list and pantry foods, rounded to steps of
 * 0.25." Each item's identity key (the same normalized name `lib/meals/parts.ts`'s `foodKey`
 * gives a plate row's food) is checked against the caller's current used-line/pantry key set;
 * a plate with no positive calories at all has no coverage to claim (0, not a divide-by-zero).
 */
export function coverageOf(
  items: readonly { key: string; kcal: number }[], usedKeys: ReadonlySet<string>,
): number {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.kcal), 0);
  if (!(total > 0)) return 0;
  const covered = items.filter((item) => usedKeys.has(item.key))
    .reduce((sum, item) => sum + Math.max(0, item.kcal), 0);
  return Math.round((covered / total) * 4) / 4;
}

/** One food identity that counts as "on the list or in the pantry" from `from` to `to` (inclusive). */
export type FocusKey = { key: string; from: string; to: string };

/** What the phone and the coach rank by: the stored end and the dated keys (GET /api/shopping/focus). */
export type FocusState = { until: string | null; keys: FocusKey[] };

/** The identity `lib/meals/parts.ts` `foodKey` gives a food of this name (same normalization). */
export function focusNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

type KeyPeriod = Pick<ShoppingPeriod, "id" | "startDate" | "endDate">;
type KeyLine = Pick<ShoppingLine, "id" | "periodId" | "name" | "checked" | "origin">;

/**
 * D7's evidence as dated keys: every used line (checked, a checked purchase window, or manual)
 * for its period's line box, and every confirmed pantry item for its 14-day box. The caller reads
 * only live rows (soft-deleted periods, lines, windows and pantry items left out).
 */
export function focusKeysFrom(input: {
  periods: readonly KeyPeriod[]; lines: readonly KeyLine[];
  checkedWindowLineIds: ReadonlySet<string>;
  pantry: readonly Pick<PantryItem, "name" | "confirmedAt">[]; zone?: string | null;
}): FocusKey[] {
  const byId = new Map(input.periods.map((period) => [period.id, period]));
  const keys: FocusKey[] = [];
  for (const line of input.lines) {
    const period = byId.get(line.periodId);
    if (!period || !isUsedLine(line, input.checkedWindowLineIds.has(line.id))) continue;
    const key = focusNameKey(line.name);
    if (key) keys.push({ key, from: period.startDate, to: lineBoxEnd(period) });
  }
  for (const item of input.pantry) {
    const key = focusNameKey(item.name);
    const from = dateIn(item.confirmedAt, input.zone);
    if (key) keys.push({ key, from, to: addDays(from, PANTRY_BOX_DAYS) });
  }
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return keys.sort((a, b) => cmp(a.key, b.key) || cmp(a.from, b.from) || cmp(a.to, b.to));
}

/** The keys that count on `date`. */
export function focusKeysOn(keys: readonly FocusKey[], date: string): Set<string> {
  return new Set(keys.filter((row) => date >= row.from && date <= row.to).map((row) => row.key));
}

/**
 * The plate ranking's focus input for `date`, or undefined when focus is off: unset, ended by
 * `now`, or `date` after the end's own date (in `zone`; the device's zone without one). While on,
 * every generator ranks by (fits, coverage, score) — D7 — even when no key counts that day.
 */
export function focusRankingOn(state: FocusState | null | undefined, date: string, now: Date,
  zone?: string | null): (FocusRanking & { id: string }) | undefined {
  if (!state || !shoppingFocusActive(state.until, now)) return undefined;
  if (date > dateIn(state.until as string, zone)) return undefined;
  const used = focusKeysOn(state.keys, date);
  return { id: `${state.until}|${[...used].sort().join(",")}`,
    coverageOf: (items) => coverageOf(items, used) };
}
