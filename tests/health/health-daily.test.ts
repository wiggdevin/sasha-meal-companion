import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { eachLocalDate, mergedDays, weighInsKg } from "@/lib/server/health-daily";

const SAMPLES = [
  { type: "step_count", value: 1000, unit: "count", start_time: "2026-09-15T17:00:00Z",
    end_time: "2026-09-15T18:00:00Z", tz: "America/New_York", device_label: "Apple Watch",
    health_sources: { kind: "health_auto_export" } },
  { type: "step_count", value: 600, unit: "count", start_time: "2026-09-15T17:30:00Z",
    end_time: "2026-09-15T18:30:00Z", tz: "America/New_York", device_label: "iPhone",
    health_sources: { kind: "apple_health_shortcut" } },
  { type: "body_mass", value: 57.6, unit: "kg", start_time: "2026-09-17T11:12:00Z",
    end_time: "2026-09-17T11:12:00Z", tz: "America/New_York", device_label: "Withings",
    health_sources: { kind: "manual" } },
  { type: "resting_heart_rate", value: 47, unit: "bpm", start_time: "2026-09-15T06:00:00Z",
    end_time: "2026-09-15T06:05:00Z", tz: "America/New_York", device_label: "Oura",
    health_sources: { kind: "oura" } },
];

type Row = Record<string, unknown>;

/**
 * An in-memory `health_samples` table carrying the two things the real PostgREST has and a stub that
 * returns its array does not: `(start_time, id)` ordering with the keyset `.or()` continuation the
 * reader sends, and `max_rows` (supabase/config.toml, 1,000) truncating any response that asks for
 * more. A paging test that does not enforce the cap proves nothing, so the cap is enforced by
 * default here, and `.range()` is kept so the pre-fix code can be run against the same table.
 *
 * The keyset filter IS applied — that is the thing under test — while `eq`/`gte`/`lt` are not (the
 * rows handed in are already the ones the query matches, as in the old stub). Each `from()` is a
 * fresh query, so paging state cannot leak between pages, and `onRequest` lets a test change the
 * table BETWEEN two pages, which is the race this suite exists for.
 */
function stubSelect(rows: unknown[], cap = 1000, onRequest?: (call: number) => void) {
  let calls = 0;
  /** The ids of every row the reader has been handed, one entry per page — what it ASKED for. */
  const served: string[][] = [];
  const query = () => {
    const order: { column: string; ascending: boolean }[] = [];
    let limit: number | null = null;
    let offset = 0;
    let after: { time: string; id: string } | null = null;
    const run = () => {
      const call = calls;
      calls += 1;
      onRequest?.(call);
      let out = rows as Row[];
      if (after) {
        out = out.filter((row) => {
          const time = String(row.start_time ?? "");
          const id = String(row.id ?? "");
          return time > after!.time || (time === after!.time && id > after!.id);
        });
      }
      for (const { column, ascending } of [...order].reverse()) {
        out = [...out].sort((a, b) => {
          const x = String(a[column] ?? ""), y = String(b[column] ?? "");
          return (ascending ? x.localeCompare(y) : y.localeCompare(x));
        });
      }
      const size = Math.min(limit ?? cap, cap);
      const page = out.slice(offset, offset + size);
      served.push(page.map((row) => String(row.id ?? "")));
      return { data: page, error: null };
    };
    const q = {
      select: () => q,
      eq: () => q,
      gte: () => q,
      lt: () => q,
      order: (column: string, options?: { ascending?: boolean }) => {
        order.push({ column, ascending: options?.ascending !== false });
        return q;
      },
      limit: (n: number) => { limit = n; return q; },
      range: (from: number, to: number) => { offset = from; limit = to - from + 1; return q; },
      or: (filter: string) => { after = keysetOf(filter); return q; },
      then: <T>(resolve: (value: { data: Row[]; error: null }) => T) =>
        Promise.resolve(run()).then(resolve),
    };
    return q;
  };
  return { from: vi.fn(query), served } as unknown as SupabaseClient
    & { from: ReturnType<typeof vi.fn>; served: string[][] };
}

/**
 * The one `or` filter `rawSamples` sends — `start_time.gt.<t>,and(start_time.eq.<t>,id.gt.<id>)` —
 * unpacked. Anything else is a bug in the reader, not a case to tolerate.
 */
function keysetOf(filter: string): { time: string; id: string } {
  const match = /^start_time\.gt\.([^,]+),and\(start_time\.eq\.([^,]+),id\.gt\.([^)]+)\)$/
    .exec(filter);
  if (!match) throw new Error(`unsupported or() continuation: ${filter}`);
  return { time: match[2], id: match[3] };
}

describe("eachLocalDate", () => {
  it("is inclusive at both ends and crosses a month", () => {
    expect(eachLocalDate("2026-09-29", "2026-10-01"))
      .toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
  });
});

describe("mergedDays", () => {
  it("returns one row per day in the window, merged, with gaps as nulls", async () => {
    const days = await mergedDays(stubSelect(SAMPLES), "user-1", "2026-09-15", "2026-09-17");
    expect(days.map((d) => d.local_date)).toEqual(["2026-09-15", "2026-09-16", "2026-09-17"]);
    expect(days[0].steps).toBe(1300);
    expect(days[0].resting_heart_rate).toBe(47);
    expect(days[1]).toEqual({ local_date: "2026-09-16", steps: null, active_kcal: null,
      sleep_minutes: null, body_mass_kg: null, resting_heart_rate: null, hrv_sdnn: null,
      readiness_score: null, sources: [], provenance: {} });
    expect(days[2].body_mass_kg).toBe(57.6);
  });

  it("returns every day as empty when there are no samples at all", async () => {
    const days = await mergedDays(stubSelect([]), "user-1", "2026-09-15", "2026-09-16");
    expect(days).toHaveLength(2);
    expect(days.every((d) => d.steps === null && d.sources.length === 0)).toBe(true);
  });

  // T11b finding 2: PostgREST caps one response at max_rows (1,000) and truncates the rest without
  // an error, so a dense window used to roll up a fraction of the day. The raw read is paged by
  // (start_time, id) until a short page, and this fake enforces the cap.
  it("reads past the 1,000-row cap instead of rolling up a truncated day", async () => {
    const dense = Array.from({ length: 1250 }, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      type: "step_count", value: 1, unit: "count",
      start_time: new Date(Date.parse("2026-09-15T04:00:00Z") + n * 60_000).toISOString(),
      end_time: new Date(Date.parse("2026-09-15T04:01:00Z") + n * 60_000).toISOString(),
      tz: "America/New_York", device_label: "Apple Watch",
      health_sources: { kind: "health_auto_export" },
    }));
    const client = stubSelect(dense);
    const days = await mergedDays(client, "user-1", "2026-09-15", "2026-09-15");

    expect(client.from.mock.calls.length).toBeGreaterThan(1);   // it did page, not truncate
    expect(days[0].steps).toBe(1250);                           // the cap would have said 1000
  });

  // The same cap, one page short of it: 1,000 rows exactly must not be read as "exhausted" and
  // dropped — the empty follow-up page is what ends the walk.
  it("keeps a window whose row count is exactly the cap", async () => {
    const dense = Array.from({ length: 1000 }, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      type: "step_count", value: 1, unit: "count",
      start_time: new Date(Date.parse("2026-09-15T04:00:00Z") + n * 60_000).toISOString(),
      end_time: new Date(Date.parse("2026-09-15T04:01:00Z") + n * 60_000).toISOString(),
      tz: "America/New_York", device_label: "Apple Watch",
      health_sources: { kind: "health_auto_export" },
    }));
    const days = await mergedDays(stubSelect(dense), "user-1", "2026-09-15", "2026-09-15");
    expect(days[0].steps).toBe(1000);
  });

  // T11b finding 3: an OFFSET page is a position in a list, so a watch that syncs a sample while
  // the walk is between two requests shifts every later position — the 1,000th row comes back again
  // as the first row of page two. The keyset continuation is stable under the insert, so a row can
  // never be handed to the reader twice. (The steps number cannot show this: `rollUpDay` merges
  // overlapping intervals, and a row paired with itself is exactly that. The read itself is what
  // the walk owns, so the read is what this test counts.)
  it("does not double-count a sample when a watch syncs one mid-walk", async () => {
    const day = (n: number) => {
      const start = new Date(Date.parse("2026-09-15T04:00:00Z") + n * 60_000).toISOString();
      return { id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        type: "step_count", value: 1, unit: "count", start_time: start,
        end_time: new Date(Date.parse(start) + 60_000).toISOString(),
        tz: "America/New_York", device_label: "Apple Watch",
        health_sources: { kind: "health_auto_export" } };
    };
    const rows: Row[] = Array.from({ length: 1250 }, (_, n) => day(n));
    const inserted = day(0);
    inserted.id = "11111111-1111-4111-8111-111111111111";
    inserted.start_time = "2026-09-15T03:00:00Z";            // sorts BEFORE every row on page one
    inserted.value = 1;

    // One request answered, then the phone syncs: exactly the window the offset walk gets wrong.
    const client = stubSelect(rows, 1000, (call) => { if (call === 1) rows.push(inserted); });
    const days = await mergedDays(client, "user-1", "2026-09-15", "2026-09-15");

    expect(client.from.mock.calls.length).toBeGreaterThan(1);
    const read = client.served.flat();
    expect(read).toHaveLength(new Set(read).size);      // RED: the 1,000th row twice
    expect(new Set(read).size).toBe(1250);              // every row that existed when it started
    expect(days[0].steps).toBe(1250);                   // …and the day is complete
  });

  it("names the source kind behind each metric and the latest contributing time", async () => {
    const days = await mergedDays(stubSelect(SAMPLES), "user-1", "2026-09-15", "2026-09-17");
    // Two step samples that day: the newest end_time (the iPhone, 18:30Z) is the one named.
    expect(days[0].provenance.step_count).toEqual({ kind: "apple_health_shortcut",
      end: "2026-09-15T18:30:00Z" });
    expect(days[0].provenance.active_energy).toBeUndefined();
    expect(days[2].provenance.body_mass).toEqual({ kind: "manual",
      end: "2026-09-17T11:12:00Z" });
  });

  it("names the source behind each heart metric too, on the rule its value uses", async () => {
    const days = await mergedDays(stubSelect(SAMPLES), "user-1", "2026-09-15", "2026-09-17");
    // One RHR sample that day, so the day's minimum is it: kind and end both come from it.
    expect(days[0].provenance.resting_heart_rate).toEqual({ kind: "oura",
      end: "2026-09-15T06:05:00Z" });
    expect(days[0].provenance.hrv_sdnn).toBeUndefined();
  });

  // Eighth round, finding 4: the API path (and the MCP tool behind the same function) carries the
  // fractional reading the watch sent, exactly as the SQL view does. Rounding here was the
  // disagreement the finding is about; the renderer is what rounds.
  it("carries a fractional RHR and HRV through the shared read path, unrounded", async () => {
    const rows = [...SAMPLES,
      { type: "resting_heart_rate", value: 46.4, unit: "bpm", start_time: "2026-09-15T19:00:00Z",
        end_time: "2026-09-15T19:05:00Z", tz: "America/New_York", device_label: "Oura",
        health_sources: { kind: "oura" } },
      { type: "hrv_sdnn", value: 40.5, unit: "ms", start_time: "2026-09-15T06:00:00Z",
        end_time: "2026-09-15T06:05:00Z", tz: "America/New_York", device_label: "Oura",
        health_sources: { kind: "oura" } },
      { type: "hrv_sdnn", value: 50.25, unit: "ms", start_time: "2026-09-15T19:00:00Z",
        end_time: "2026-09-15T19:05:00Z", tz: "America/New_York", device_label: "Oura",
        health_sources: { kind: "oura" } }];
    const days = await mergedDays(stubSelect(rows), "user-1", "2026-09-15", "2026-09-15");
    expect(days[0].resting_heart_rate).toBe(46.4);   // the day's minimum, not 46
    expect(days[0].hrv_sdnn).toBe(45.375);
  });

  // T11b finding 3, end to end on the read path the dashboard and the MCP tool share: a readiness
  // sample reaches the row with its own source and time, and a day without one stays null.
  it("carries readiness through the raw-sample read, with its own provenance", async () => {
    const rows = [...SAMPLES, { type: "readiness_score", value: 78, unit: "score",
      start_time: "2026-09-15T12:00:00Z", end_time: "2026-09-15T12:00:00Z",
      tz: "America/New_York", device_label: "Oura", health_sources: { kind: "oura" } }];
    const days = await mergedDays(stubSelect(rows), "user-1", "2026-09-15", "2026-09-17");
    expect(days[0].readiness_score).toBe(78);
    expect(days[0].provenance.readiness_score).toEqual({ kind: "oura",
      end: "2026-09-15T12:00:00Z" });
    expect(days[1].readiness_score).toBeNull();
    expect(days[1].provenance.readiness_score).toBeUndefined();
  });

  it("keeps each date's source kind when two sources share one device label", async () => {
    const rows = [
      { type: "step_count", value: 1000, unit: "count", start_time: "2026-09-15T17:00:00Z",
        end_time: "2026-09-15T18:00:00Z", tz: "America/New_York", device_label: "Watch",
        health_sources: { kind: "health_auto_export" } },
      { type: "step_count", value: 800, unit: "count", start_time: "2026-09-16T17:00:00Z",
        end_time: "2026-09-16T18:00:00Z", tz: "America/New_York", device_label: "Watch",
        health_sources: { kind: "apple_health_shortcut" } },
    ];
    const days = await mergedDays(stubSelect(rows), "user-1", "2026-09-15", "2026-09-16");
    expect(days[0].provenance.step_count.kind).toBe("health_auto_export");
    expect(days[1].provenance.step_count.kind).toBe("apple_health_shortcut");
  });

  it("names the kind of the sample it names, not the first source that used the label", async () => {
    const label = "Apple Watch";
    const rows = [
      { type: "step_count", value: 1000, unit: "count", start_time: "2026-09-15T17:00:00Z",
        end_time: "2026-09-15T18:00:00Z", tz: "America/New_York", device_label: label,
        health_sources: { kind: "health_auto_export" } },
      { type: "step_count", value: 600, unit: "count", start_time: "2026-09-15T17:30:00Z",
        end_time: "2026-09-15T18:30:00Z", tz: "America/New_York", device_label: label,
        health_sources: { kind: "apple_health_shortcut" } },
    ];
    const days = await mergedDays(stubSelect(rows), "user-1", "2026-09-15", "2026-09-15");
    // The named sample is the second (latest end), so its kind must be the one reported.
    expect(days[0].provenance.step_count).toEqual({ kind: "apple_health_shortcut",
      end: "2026-09-15T18:30:00Z" });
  });
});

describe("weighInsKg", () => {
  it("converts every weigh_ins row through toCanonical, pounds included", async () => {
    const rows = [{ local_date: "2026-09-15", value: 127.2, unit: "lb" },
      { local_date: "2026-09-16", value: 57.5, unit: "kg" }];
    const out = await weighInsKg(stubSelect(rows), "user-1", "2026-09-15", "2026-09-16");
    expect(out[0].kg).toBeCloseTo(57.697, 3);
    expect(out[1]).toEqual({ date: "2026-09-16", kg: 57.5 });
  });

  it("lets a scale reading beat a typed one on the same day, as the dashboard does (A050)", async () => {
    const rows = [
      { local_date: "2026-09-15", value: 80.0, unit: "kg", source_kind: "health_auto_export" },
      { local_date: "2026-09-15", value: 80.4, unit: "kg", source_kind: "manual" },
      { local_date: "2026-09-16", value: 80.2, unit: "kg", source_kind: "manual" },
      { local_date: "2026-09-17", value: 79.8, unit: "kg", source_kind: "oura" },
      { local_date: "2026-09-17", value: 79.9, unit: "kg", source_kind: "health_auto_export" },
    ];
    const out = await weighInsKg(stubSelect(rows), "user-1", "2026-09-15", "2026-09-17");
    // Sept 15: the typed 80.4 is dropped. Sept 16: a typed number alone still counts. Sept 17: both
    // device readings stay; the engine takes their median (ruling R1).
    expect(out).toEqual([{ date: "2026-09-15", kg: 80.0 }, { date: "2026-09-16", kg: 80.2 },
      { date: "2026-09-17", kg: 79.8 }, { date: "2026-09-17", kg: 79.9 }]);
  });

  it("asks weigh_ins for each reading's source kind", async () => {
    const selects: string[] = [];
    const q: Record<string, unknown> = {
      select: (columns: string) => { selects.push(columns); return q; },
      eq: () => q, gte: () => q, lt: () => q,
      then: <T>(resolve: (value: { data: Row[]; error: null }) => T) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    await weighInsKg({ from: () => q } as unknown as SupabaseClient, "user-1", "2026-09-15",
      "2026-09-15");
    expect(selects).toEqual(["local_date, value, unit, source_kind"]);
  });
});
