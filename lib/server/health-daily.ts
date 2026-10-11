/**
 * The ONE read path for merged days (contracts §2). GET /api/health/daily, the MCP get_body_data tool
 * and Phase 6's estimator all come through here, so none of them can see a different number than the
 * dashboard. It reads raw health_samples rows and applies lib/health/daily.ts — never the plain
 * daily_health view, which is an aggregate without the §3.5 preference rules (spec §4).
 *
 * `client` is whichever client the caller already holds: the RLS-scoped request client on the browser
 * path, the admin client inside the privileged boundary. The explicit .eq('user_id') satisfies §2.2
 * rule 3 either way.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readByDateChunks } from "@/lib/server/date-chunks";
import type { DailyHealthResponse, DailyHealthRow, NormalizedSample } from "@/lib/health/contract";
import { emptyDay, localDateOf, rollUpDay } from "@/lib/health/daily";
import { toCanonical } from "@/lib/health/units";

const DAY_MS = 86_400_000;
/** PostgREST answers at most `max_rows` rows (supabase/config.toml, 1,000) and TRUNCATES the rest
 *  without an error, so a dense window has to be walked in pages. A short page is the last one. */
const SAMPLE_PAGE = 1000;

export function eachLocalDate(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const dates: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) dates.push(new Date(t).toISOString().slice(0, 10));
  return dates;
}

type SampleRow = { id: string; type: string; value: number; unit: string; start_time: string;
  end_time: string; tz: string; device_label: string | null; vendor_sample_id: string | null;
  health_sources: { kind: string } | null };

// `id` rides along because it is the tie-breaker of the page key: the continuation filter is
// `start_time > last OR (start_time = last AND id > lastId)`, which needs the last row's id.
const SAMPLE_COLUMNS = "type, value, unit, start_time, end_time, tz, device_label, "
  + "vendor_sample_id, health_sources(kind), id";

function toSample(row: SampleRow): NormalizedSample {
  return { type: row.type as NormalizedSample["type"],
    value: Number(row.value), unit: row.unit, start_time: row.start_time, end_time: row.end_time,
    tz: row.tz, device_label: row.device_label ?? undefined,
    vendor_sample_id: row.vendor_sample_id ?? undefined,
    source_kind: row.health_sources?.kind ?? undefined };
}

/**
 * Every raw sample in the window, a page at a time, by KEYSET continuation on `(start_time, id)` —
 * a total order over the rows, so a page starts where the previous one ended and nothing is read
 * twice.
 *
 * The continuation is not an offset. An offset page is a position in a list, and a watch that
 * syncs a sample while the walk is between two requests shifts every later position: the last row
 * of page one comes back again as the first of page two (counted twice) and the row that fell off
 * the end is never read (T11b audit finding 3). Asking for "strictly after this row" is stable
 * under an insert, which is why the filter is spelled out rather than paged with `.range()`.
 *
 * The 1,000-row cap is not advisory. One dense window — an hour of per-minute heart rate, or a
 * month of a chatty watch — otherwise comes back truncated, and the day's steps, sleep and heart
 * metrics are quietly computed from part of the data (T11b audit finding 2). Paginating here, in
 * the one shared read path, is what makes the dashboard, the MCP tool, the TDEE inputs and the
 * export complete; truncating anywhere upstream would only raise the ceiling.
 */
async function rawSamples(client: SupabaseClient, userId: string, from: string, to: string):
    Promise<NormalizedSample[]> {
  // One day of slack at each end: a 23:30 local sample is tomorrow in UTC, and the reverse.
  const lower = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString();
  const upper = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const samples: NormalizedSample[] = [];
  let after: { start_time: string; id: string } | null = null;
  for (;;) {
    let query = client.from("health_samples").select(SAMPLE_COLUMNS)
      .eq("user_id", userId)
      .gte("start_time", lower)
      .lt("start_time", upper)
      .order("start_time", { ascending: true })
      .order("id", { ascending: true });
    if (after) {
      // PostgREST's `or`: the strict time-greater case, or the tie broken by id.
      query = query.or(`start_time.gt.${after.start_time},`
        + `and(start_time.eq.${after.start_time},id.gt.${after.id})`);
    }
    const { data, error } = await query.limit(SAMPLE_PAGE);
    if (error) throw error;
    // PostgREST embeds to-one relations as an object; the generated types call it an array.
    const page = (data ?? []) as unknown as SampleRow[];
    for (const row of page) samples.push(toSample(row));
    if (page.length < SAMPLE_PAGE) return samples;
    const last = page[page.length - 1];
    after = { start_time: last.start_time, id: String(last.id) };
  }
}

export async function mergedDays(client: SupabaseClient, userId: string, from: string, to: string):
    Promise<DailyHealthRow[]> {
  // `health_sources(kind)` rides the source_id FK so each metric on a day can name the kind of
  // source behind it (Sol audit, T11a); `device_label` on the sample is what the card shows.
  const samples = await rawSamples(client, userId, from, to);
  const buckets = new Map<string, NormalizedSample[]>();
  for (const sample of samples) {
    const date = localDateOf(sample.start_time, sample.tz);
    const bucket = buckets.get(date);
    if (bucket) bucket.push(sample); else buckets.set(date, [sample]);
  }

  return eachLocalDate(from, to).map((date) => {
    const bucket = buckets.get(date);
    if (!bucket || bucket.length === 0) return emptyDay(date);
    // The kind rides each sample, so the roll-up can name the winner's own source regardless of any
    // other date or source that shares its device_label (Sol audit, T11a).
    return rollUpDay(bucket, bucket[0].tz);
  });
}

type WeighInRow = { local_date: string; value: number; unit: string; source_kind?: string | null };

/**
 * T8 §2, the dashboard's rule (lib/health/daily.ts rollUpDay, `daily_health`): on a day with a
 * device reading, a number the user typed does not count. Otherwise the estimator's daily median
 * (ruling R1) would blend the scale's 80.0 with a typed 80.4 the dashboard never shows (A050). A row
 * with no source kind is an ingest reading: only `health_weigh_in` writes 'manual'.
 */
function scaleBeatsManual(rows: WeighInRow[]): WeighInRow[] {
  const deviceDays = new Set(rows.filter((r) => r.source_kind !== "manual").map((r) => r.local_date));
  return rows.filter((r) => r.source_kind !== "manual" || !deviceDays.has(r.local_date));
}

export async function weighInsKg(client: SupabaseClient, userId: string, from: string, to: string):
    Promise<{ date: string; kg: number }[]> {
  // Date windows, so five years of weigh-ins never meet the 1,000-row cap (lib/server/date-chunks.ts).
  const data = await readByDateChunks(from, to, async (start, end) => {
    const { data: rows, error } = await client.from("weigh_ins")
      .select("local_date, value, unit, source_kind")
      .eq("user_id", userId)
      .gte("local_date", start)
      .lt("local_date", new Date(Date.parse(`${end}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10));
    if (error) throw error;
    return (rows ?? []) as WeighInRow[];
  });
  return scaleBeatsManual(data)
    .map((row) => ({ date: row.local_date,
      kg: toCanonical("body_mass", Number(row.value), row.unit).value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function listSources(client: SupabaseClient, userId: string):
    Promise<DailyHealthResponse["sources"]> {
  const { data, error } = await client.from("health_source_status")
    .select("id, kind, device_label, revoked_at, last_received_at").eq("user_id", userId);
  if (error) throw error;
  const sources = (data ?? []) as { id: string; kind: string; device_label: string | null;
    revoked_at: string | null; last_received_at: string | null }[];

  return sources.map((s) => ({ id: s.id, kind: s.kind, device_label: s.device_label,
    last_received_at: s.last_received_at, revoked: s.revoked_at !== null }));
}
