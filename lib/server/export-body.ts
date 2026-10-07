/**
 * T11b: the two body kinds of the export.
 *
 * The Phase 0 settings select (`lib/server/export.ts`, `loadSettings`) carries the five legacy
 * columns only, and that file is already over the 400-line house limit, so both kinds live here and
 * `app/api/export/route.ts` imports the streams directly. `ExportJson` and `ExportOpts` are
 * type-only imports, so there is no value cycle back into export.ts.
 *
 * - `body-profile`: the four formula inputs, one row per user, no cursor.
 * - `body-data` (Sol audit findings 2 and 4): the rolled-up daily rows — the numbers the dashboard
 *   shows, RHR, HRV and readiness included. Sol's second audit rejected reading the SQL
 *   `daily_health` view here: it sums overlapping Watch and phone activity and takes the max sleep
 *   sample, so it is NOT the canonical roll-up. This reads raw `health_samples` through the one
 *   shared path (`mergedDays` → `rollUpDay`) instead, and keeps the export's own `limit`/`cursor`
 *   contract: the cursor is still the last `local_date` of the page.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DailyHealthRow } from "@/lib/health/contract";
import { localDateOf } from "@/lib/health/daily";
import { HttpError } from "@/lib/server/auth";
import { mergedDays } from "@/lib/server/health-daily";
import type { ExportJson, ExportOpts } from "@/lib/server/export";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Days of raw samples one `mergedDays` call rolls up. The raw read pages itself (PostgREST caps a
 *  response at 1,000 rows — see lib/server/health-daily.ts), so this bound is about how much work
 *  one call does, not about staying under the cap. */
const ROLLUP_DAYS_PER_QUERY = 31;

export type BodyProfileExportRow = { height_cm: number | null; birth_year: number | null;
  sex: string | null; body_fat_pct: number | null };

export const BODY_PROFILE_COLUMNS: string[] = ["height_cm", "birth_year", "sex", "body_fat_pct"];

export function bodyProfileRowValues(row: BodyProfileExportRow):
    (string | number | null)[] {
  return BODY_PROFILE_COLUMNS.map((column) =>
    (row as unknown as Record<string, string | number | null>)[column] ?? null);
}

/** The row as the export spells it: the four columns only, and a cleared field is null. */
export function toBodyProfileRow(row: Record<string, unknown>): BodyProfileExportRow {
  const number = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return { height_cm: number(row.height_cm), birth_year: number(row.birth_year),
    sex: (row.sex as string | null | undefined) ?? null, body_fat_pct: number(row.body_fat_pct) };
}

export async function streamBodyProfile(
  client: SupabaseClient, userId: string, opts: ExportOpts,
): Promise<ExportJson<BodyProfileExportRow>> {
  void opts; // The kind is one row, so from/to/cursor/limit have nothing to page or filter.
  const { data, error } = await client.from("user_settings")
    .select("height_cm, birth_year, sex, body_fat_pct")
    .eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const profile = data as Record<string, unknown> | null;
  return { rows: profile ? [toBodyProfileRow(profile)] : [], notices: [], next_cursor: null };
}

/** The rolled-up daily row, with the two heart metrics and readiness T11b added. */
export type BodyDataExportRow = { local_date: string; steps: number | null;
  active_kcal: number | null; sleep_minutes: number | null; body_mass_kg: number | null;
  resting_heart_rate: number | null; hrv_sdnn: number | null; readiness_score: number | null };

/** Column order for both JSON keys and the CSV header. */
export const BODY_DATA_COLUMNS: string[] = ["local_date", "steps", "active_kcal", "sleep_minutes",
  "body_mass_kg", "resting_heart_rate", "hrv_sdnn", "readiness_score"];

/** One rolled-up day, narrowed to the export's columns. */
export function toBodyDataRow(day: DailyHealthRow): BodyDataExportRow {
  return { local_date: day.local_date, steps: day.steps, active_kcal: day.active_kcal,
    sleep_minutes: day.sleep_minutes, body_mass_kg: day.body_mass_kg,
    resting_heart_rate: day.resting_heart_rate, hrv_sdnn: day.hrv_sdnn,
    readiness_score: day.readiness_score };
}

export function bodyDataRowValues(row: BodyDataExportRow): (string | number | null)[] {
  return BODY_DATA_COLUMNS.map((column) =>
    (row as unknown as Record<string, string | number | null>)[column] ?? null);
}

/** A day earns a row only when it carries at least one observation — the view dropped empty days. */
function observed(row: BodyDataExportRow): boolean {
  return BODY_DATA_COLUMNS.some((column) => column !== "local_date"
    && (row as unknown as Record<string, unknown>)[column] !== null);
}

function addDays(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The span of local dates their samples can land on, so a page never walks decades of empty days.
 * One sample row at each end is enough for the EXTREMES, but both edges are UTC and a sample's own
 * local date can be a day either side of its UTC date — 23:30 local is tomorrow in UTC, and a
 * second timezone's samples sit on the local date of their own zone, not of whichever row happens
 * to be at the UTC edge. A timezone change used to drop that boundary date from the export
 * (T11b audit finding 3). So the span is each UTC edge ± 1 day; the slack days carry no
 * observation and `observed` drops them.
 */
async function sampleSpan(client: SupabaseClient, userId: string):
    Promise<{ earliest: string; latest: string } | null> {
  const edge = async (ascending: boolean) => {
    const { data, error } = await client.from("health_samples").select("start_time")
      .eq("user_id", userId).order("start_time", { ascending }).limit(1);
    if (error) throw error;
    const row = ((data ?? []) as { start_time: string }[])[0];
    return row ? localDateOf(row.start_time, "UTC") : null;
  };
  const [earliestUtc, latestUtc] = await Promise.all([edge(true), edge(false)]);
  return earliestUtc && latestUtc
    ? { earliest: addDays(earliestUtc, -1), latest: addDays(latestUtc, 1) } : null;
}

/**
 * The daily rows in `[from, to]`, oldest first, one page at a time. Each `mergedDays` call reads at
 * most `ROLLUP_DAYS_PER_QUERY` days of raw samples and the loop walks forward until the page is
 * full, so overlapping Watch/phone activity and Apple-vs-Oura sleep are merged exactly as the
 * dashboard merges them. `next_cursor` is the last returned `local_date` — the caller asks for the
 * next page from the following day, and nothing is skipped or repeated.
 */
export async function streamBodyData(
  client: SupabaseClient, userId: string, opts: ExportOpts,
): Promise<ExportJson<BodyDataExportRow>> {
  if (opts.cursor && !LOCAL_DATE.test(opts.cursor)) {
    throw new HttpError(400, "bad_request", "malformed cursor");
  }
  const span = await sampleSpan(client, userId);
  if (!span) return { rows: [], notices: [], next_cursor: null };

  const from = opts.from && opts.from > span.earliest ? opts.from : span.earliest;
  const to = opts.to && opts.to < span.latest ? opts.to : span.latest;
  // A cursor and `from` are both floors on the window, so the later one wins — the same rule the
  // other export kinds get by applying both filters (T11b audit finding 4). Starting at the cursor
  // alone used to hand back days before `from` on a page that carries both.
  const afterCursor = opts.cursor ? addDays(opts.cursor, 1) : from;
  const firstDay = afterCursor > from ? afterCursor : from;
  if (firstDay > to) return { rows: [], notices: [], next_cursor: null };

  const step = Math.max(1, Math.min(opts.limit, ROLLUP_DAYS_PER_QUERY));
  const rows: BodyDataExportRow[] = [];
  let day = firstDay;
  while (day <= to && rows.length < opts.limit) {
    const windowEnd = addDays(day, step - 1) < to ? addDays(day, step - 1) : to;
    const merged = await mergedDays(client, userId, day, windowEnd);
    for (const mergedDay of merged) {
      const row = toBodyDataRow(mergedDay);
      if (observed(row)) rows.push(row);
      if (rows.length === opts.limit) break;
    }
    day = addDays(windowEnd, 1);
  }

  const last = rows[rows.length - 1];
  const full = rows.length === opts.limit;
  return { rows, notices: [], next_cursor: full && last && last.local_date < to
    ? last.local_date : null };
}
