/**
 * T11b: the two body kinds of `/api/export` — `body-profile` (the four formula inputs) and
 * `body-data` (the rolled-up daily rows, RHR, HRV and readiness included). Sol audit finding 10:
 * the route is exercised by calling `GET`, never by grepping its source. `requireUser` is mocked
 * here so JSON, CSV and the 401 all run without a preview branch; the cross-user case runs against
 * a branch in `tests/export/cross-user.test.ts`.
 *
 * Third round (Sol audit finding 2): `body-data` no longer reads the SQL `daily_health` view — that
 * view sums overlapping Watch and phone activity and takes the sleep maximum, so it is not the
 * canonical roll-up. It reads raw `health_samples` and rolls them up through the shared
 * `mergedDays` → `rollUpDay` path, and this file proves the export equals the dashboard on a day
 * with exactly those overlaps.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";

// lib/server/export-body.ts imports "server-only"; the marker package is stubbed, never the module.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));

const { BODY_DATA_COLUMNS, BODY_PROFILE_COLUMNS, bodyDataRowValues, bodyProfileRowValues,
  streamBodyData, streamBodyProfile } = await import("@/lib/server/export-body");
const { mergedDays } = await import("@/lib/server/health-daily");
const { GET } = await import("../../app/api/export/route");

const user = vi.mocked(requireUser);
const USER_ID = "user-1";
const TZ = "America/New_York";

describe("the body-profile export columns", () => {
  it("names the four profile fields, in order, and nothing else", () => {
    expect(BODY_PROFILE_COLUMNS).toEqual(["height_cm", "birth_year", "sex", "body_fat_pct"]);
  });

  it("maps a row into column order and leaves a cleared field null", () => {
    expect(bodyProfileRowValues({ height_cm: 165, birth_year: 1996, sex: "female",
      body_fat_pct: 25 })).toEqual([165, 1996, "female", 25]);
    expect(bodyProfileRowValues({ height_cm: null, birth_year: null, sex: null,
      body_fat_pct: null })).toEqual([null, null, null, null]);
  });
});

describe("streamBodyProfile", () => {
  it("returns one row of the four fields, and no cursor to page", async () => {
    const { client, selected } = settingsClient({ user_id: "u1", height_cm: 165, birth_year: 1996,
      sex: "female", body_fat_pct: 25 });
    const page = await streamBodyProfile(client, "u1", { limit: 1000 });
    expect(selected).toEqual(["height_cm, birth_year, sex, body_fat_pct"]);
    expect(page).toEqual({ rows: [{ height_cm: 165, birth_year: 1996, sex: "female",
      body_fat_pct: 25 }], next_cursor: null, notices: [] });
  });

  it("returns an empty page for a user with no settings row", async () => {
    const { client } = settingsClient(null);
    expect((await streamBodyProfile(client, "u1", { limit: 1000 })).rows).toEqual([]);
  });
});

describe("the body-data kind", () => {
  it("carries the two heart metrics and readiness, in column order", () => {
    expect(BODY_DATA_COLUMNS).toEqual(["local_date", "steps", "active_kcal", "sleep_minutes",
      "body_mass_kg", "resting_heart_rate", "hrv_sdnn", "readiness_score"]);
    expect(bodyDataRowValues({ local_date: "2026-09-11", steps: 1300, active_kcal: 96,
      sleep_minutes: null, body_mass_kg: 57.6, resting_heart_rate: 47, hrv_sdnn: 45,
      readiness_score: 70 })).toEqual(["2026-09-11", 1300, 96, null, 57.6, 47, 45, 70]);
  });

  it("rolls the raw samples up exactly as the dashboard does, overlaps and all", async () => {
    const { client, calls } = healthClient(DAY_ROWS);
    const page = await streamBodyData(client, USER_ID, { from: "2026-09-15", to: "2026-09-15",
      limit: 100 });

    // The point of the finding: the numbers come from the shared roll-up, not the SQL view.
    expect(calls.every((call) => call.table === "health_samples")).toBe(true);
    const dashboard = await mergedDays(healthClient(DAY_ROWS).client, USER_ID, "2026-09-15",
      "2026-09-15");
    expect(page.rows).toEqual([{
      local_date: dashboard[0].local_date, steps: dashboard[0].steps,
      active_kcal: dashboard[0].active_kcal, sleep_minutes: dashboard[0].sleep_minutes,
      body_mass_kg: dashboard[0].body_mass_kg,
      resting_heart_rate: dashboard[0].resting_heart_rate, hrv_sdnn: dashboard[0].hrv_sdnn,
      readiness_score: dashboard[0].readiness_score }]);

    // …and the values themselves: Watch preferred over the overlapping phone hour, Oura sleep over
    // the longer Apple one, RHR the minimum, HRV the mean, readiness the day's latest sample.
    expect(page.rows[0]).toEqual(EXPECTED_DAY);
    expect(page.rows[0].steps).not.toBe(1600);        // the view would sum both step samples
    expect(page.rows[0].sleep_minutes).not.toBe(500); // the view would take the maximum
  });

  it("drops days with no observation instead of exporting empty rows", async () => {
    const rows = [sample("step_count", 100, "count", "2026-09-01T17:00:00Z",
      "2026-09-01T18:00:00Z", "Apple Watch", "health_auto_export"),
    sample("step_count", 200, "count", "2026-09-03T17:00:00Z", "2026-09-03T18:00:00Z",
      "Apple Watch", "health_auto_export")];
    const page = await streamBodyData(healthClient(rows).client, USER_ID, { limit: 10 });
    expect(page.rows.map((r) => [r.local_date, r.steps]))
      .toEqual([["2026-09-01", 100], ["2026-09-03", 200]]);
  });

  it("pages by the last local_date, asking for the next day on", async () => {
    const rows = [1, 2, 3].map((n) => sample("step_count", n * 100, "count",
      `2026-09-0${n}T17:00:00Z`, `2026-09-0${n}T18:00:00Z`, "Apple Watch", "health_auto_export"));

    const first = await streamBodyData(healthClient(rows).client, USER_ID, { limit: 2 });
    expect(first.rows.map((r) => r.local_date)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(first.next_cursor).toBe("2026-09-02");

    const second = await streamBodyData(healthClient(rows).client, USER_ID,
      { limit: 2, cursor: first.next_cursor! });
    expect(second.rows.map((r) => r.local_date)).toEqual(["2026-09-03"]);
    expect(second.next_cursor).toBeNull();

    // The end of her data is the end of the export, whatever the caller's window says.
    const past = await streamBodyData(healthClient(rows).client, USER_ID,
      { limit: 2, cursor: "2026-09-30" });
    expect(past).toEqual({ rows: [], notices: [], next_cursor: null });
  });

  it("returns an empty page for a user with no samples at all", async () => {
    const page = await streamBodyData(healthClient([]).client, USER_ID, { limit: 10 });
    expect(page).toEqual({ rows: [], notices: [], next_cursor: null });
  });

  // T11b finding 2, on the export itself: the day's samples exceed PostgREST's 1,000-row cap, and
  // the export has to carry the whole day rather than the first thousand rows of it.
  it("exports a dense day past the 1,000-row cap", async () => {
    const dense = Array.from({ length: 1250 }, (_, n) => sample("step_count", 1, "count",
      new Date(Date.parse("2026-09-15T04:00:00Z") + n * 60_000).toISOString(),
      new Date(Date.parse("2026-09-15T04:01:00Z") + n * 60_000).toISOString(),
      "Apple Watch", "health_auto_export"));
    const page = await streamBodyData(healthClient(dense).client, USER_ID, { limit: 100 });
    expect(page.rows).toEqual([{ ...EXPECTED_DAY, steps: 1250, active_kcal: null,
      sleep_minutes: null, body_mass_kg: null, resting_heart_rate: null, hrv_sdnn: null,
      readiness_score: null }]);
  });

  // T11b finding 3: the span came from the earliest and latest UTC samples, so a second timezone
  // whose samples sit on a different LOCAL date fell outside the window — here the two boundary
  // days are 14 and 15 September, and BOTH have to survive.
  it("keeps both boundary days when her samples change timezone", async () => {
    const rows = [
      sample("step_count", 100, "count", "2026-09-15T00:30:00Z", "2026-09-15T00:40:00Z",
        "Apple Watch", "health_auto_export", "Asia/Tokyo"),
      sample("step_count", 200, "count", "2026-09-15T01:00:00Z", "2026-09-15T01:10:00Z",
        "Apple Watch", "health_auto_export", "America/Los_Angeles"),
    ];
    const page = await streamBodyData(healthClient(rows).client, USER_ID, { limit: 100 });
    expect(page.rows.map((row) => [row.local_date, row.steps]))
      .toEqual([["2026-09-14", 200], ["2026-09-15", 100]]);
  });

  // T11b finding 4: a cursor and `from` are both floors on the window, so a page carrying both
  // starts at the later one — like every other export kind, which applies both filters.
  it("starts at the later of `from` and the day after the cursor", async () => {
    const rows = [1, 2, 3, 4].map((n) => sample("step_count", n * 100, "count",
      `2026-09-0${n}T17:00:00Z`, `2026-09-0${n}T18:00:00Z`, "Apple Watch", "health_auto_export"));

    const fromWins = await streamBodyData(healthClient(rows).client, USER_ID,
      { from: "2026-09-03", limit: 10, cursor: "2026-09-01" });
    expect(fromWins.rows.map((r) => r.local_date)).toEqual(["2026-09-03", "2026-09-04"]);

    const cursorWins = await streamBodyData(healthClient(rows).client, USER_ID,
      { from: "2026-09-01", limit: 10, cursor: "2026-09-02" });
    expect(cursorWins.rows.map((r) => r.local_date)).toEqual(["2026-09-03", "2026-09-04"]);
  });

  it("rejects a malformed cursor instead of asking the database for it", async () => {
    await expect(streamBodyData(healthClient([]).client, USER_ID, { limit: 10, cursor: "tomorrow" }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe("GET /api/export?kind=body-data", () => {
  beforeEach(() => {
    resetRateLimits();
    user.mockReset().mockResolvedValue({ userId: USER_ID,
      client: healthClient(DAY_ROWS).client });
  });

  it("401s without a session", async () => {
    const { HttpError } = await vi.importActual<typeof import("@/lib/server/auth")>
      ("@/lib/server/auth");
    user.mockRejectedValue(new HttpError(401, "unauthorized"));
    const res = await GET(request("body-data", "json"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("401s the body-profile kind without a session", async () => {
    const { HttpError } = await vi.importActual<typeof import("@/lib/server/auth")>
      ("@/lib/server/auth");
    user.mockRejectedValue(new HttpError(401, "unauthorized"));
    const res = await GET(request("body-profile", "json"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("returns the rolled-up days, heart metrics and readiness, as JSON", async () => {
    const res = await GET(request("body-data", "json"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ rows: [EXPECTED_DAY], next_cursor: null,
      notices: [] });
  });

  it("returns the same rows as CSV, with the heart and readiness columns in the header", async () => {
    const res = await GET(request("body-data", "csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("meal-companion-body-data-");
    expect(await res.text()).toBe(
      "local_date,steps,active_kcal,sleep_minutes,body_mass_kg,resting_heart_rate,hrv_sdnn,"
      + "readiness_score\r\n2026-09-15,1300,360,444,57.6,47.4,45.375,70\r\n");
  });

  it("still serves the four-column body-profile kind through the same route", async () => {
    user.mockResolvedValue({ userId: USER_ID,
      client: settingsClient({ height_cm: 165, birth_year: 1996, sex: "female",
        body_fat_pct: 25 }).client });
    const res = await GET(request("body-profile", "json"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ rows: [{ height_cm: 165, birth_year: 1996,
      sex: "female", body_fat_pct: 25 }] });
  });
});

function request(kind: string, format: string): Request {
  return new Request(`https://app.test/api/export?kind=${kind}&format=${format}`);
}

/** The subset of the PostgREST builder `streamBodyProfile` uses. */
function settingsClient(row: Record<string, unknown> | null) {
  const selected: string[] = [];
  const q = {
    select(columns: string) { selected.push(columns); return q; },
    eq: () => q,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { client: { from: () => q } as unknown as SupabaseClient, selected };
}

/** One `health_samples` row, as the join with `health_sources` returns it. */
type SampleRow = { id: string; user_id: string; type: string; value: number; unit: string;
  start_time: string; end_time: string; tz: string; device_label: string;
  health_sources: { kind: string } };

/** The raw read orders by `(start_time, id)`, so every fixture row needs a stable unique id. */
let nextId = 0;

function sample(type: string, value: number, unit: string, start: string, end: string,
    deviceLabel: string, kind: string, tz: string = TZ): SampleRow {
  return { id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    user_id: USER_ID, type, value, unit, start_time: start, end_time: end, tz,
    device_label: deviceLabel, health_sources: { kind } };
}

/**
 * One day with every overlap the audit named: a Watch and a phone that share an hour of steps and
 * active energy, an Apple sleep sample longer than Oura's, two RHR samples, two HRV samples and two
 * readiness scores. The SQL view would answer 1600 steps and 500 sleep minutes; the roll-up answers
 * 1300 and 444.
 */
const DAY_ROWS: SampleRow[] = [
  sample("step_count", 1000, "count", "2026-09-15T17:00:00Z", "2026-09-15T18:00:00Z",
    "Apple Watch", "health_auto_export"),
  sample("step_count", 600, "count", "2026-09-15T17:30:00Z", "2026-09-15T18:30:00Z",
    "Sasha's iPhone", "apple_health_shortcut"),
  sample("active_energy", 300, "kcal", "2026-09-15T17:00:00Z", "2026-09-15T18:00:00Z",
    "Apple Watch", "health_auto_export"),
  sample("active_energy", 120, "kcal", "2026-09-15T17:30:00Z", "2026-09-15T18:30:00Z",
    "Sasha's iPhone", "apple_health_shortcut"),
  sample("sleep_asleep", 500, "min", "2026-09-15T04:00:00Z", "2026-09-15T12:20:00Z",
    "Apple Watch", "health_auto_export"),
  // Both start after 04:00Z, i.e. after local midnight in New York — a 03:00Z start would bucket
  // the Oura night into 14 Sep (lib/health/daily.ts localDateOf).
  sample("sleep_asleep", 444, "min", "2026-09-15T04:30:00Z", "2026-09-15T11:54:00Z",
    "Oura", "oura"),
  // Eighth round, finding 4: fractional heart values, so the export has to prove it carries the
  // number the watch reported rather than the whole number the old roll-up rounded it to.
  sample("resting_heart_rate", 52.5, "bpm", "2026-09-15T06:00:00Z", "2026-09-15T06:05:00Z",
    "Oura", "oura"),
  sample("resting_heart_rate", 47.4, "bpm", "2026-09-15T06:30:00Z", "2026-09-15T06:35:00Z",
    "Oura", "oura"),
  sample("hrv_sdnn", 40.5, "ms", "2026-09-15T06:00:00Z", "2026-09-15T06:05:00Z", "Oura", "oura"),
  sample("hrv_sdnn", 50.25, "ms", "2026-09-15T06:30:00Z", "2026-09-15T06:35:00Z", "Oura", "oura"),
  sample("readiness_score", 82, "score", "2026-09-15T11:00:00Z", "2026-09-15T11:00:00Z",
    "Oura", "oura"),
  sample("readiness_score", 70, "score", "2026-09-15T12:00:00Z", "2026-09-15T12:05:00Z",
    "Oura", "oura"),
  sample("body_mass", 57.6, "kg", "2026-09-15T11:12:00Z", "2026-09-15T11:12:00Z",
    "Withings", "manual"),
];

const EXPECTED_DAY = { local_date: "2026-09-15", steps: 1300, active_kcal: 360,
  sleep_minutes: 444, body_mass_kg: 57.6, resting_heart_rate: 47.4, hrv_sdnn: 45.375,
  readiness_score: 70 };

type Filter = { op: "eq" | "gte" | "gt" | "lte" | "lt"; column: string; value: unknown };
type Call = { table: string; select: string; filters: Filter[];
  order: { column: string; ascending: boolean }[]; limit?: number; offset?: number;
  /** The keyset continuation `rawSamples` sends: strictly after this `(start_time, id)`. */
  after?: { time: string; id: string } };

/** PostgREST stops a response at `max_rows` (supabase/config.toml), silently. */
const MAX_ROWS = 1000;

function compare(a: unknown, b: unknown, op: Filter["op"], column: string): boolean {
  if (column === "start_time" || column === "local_date") {
    const [x, y] = [String(a), String(b)];
    if (op === "eq") return x === y;
    if (op === "gte") return x >= y;
    if (op === "gt") return x > y;
    if (op === "lte") return x <= y;
    return x < y;
  }
  if (op === "eq") return String(a) === String(b);
  throw new Error(`unsupported filter ${op} on ${column}`);
}

/**
 * The builder the real PostgREST client has, over an in-memory `health_samples` table: every
 * filter, order and limit is applied for real, so `sampleSpan` and `mergedDays` see the same rows
 * a branch would return.
 */
function healthClient(rows: SampleRow[]) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, select: "", filters: [], order: [] };
    calls.push(call);
    const q = {
      select(columns: string) { call.select = columns; return q; },
      eq(column: string, value: unknown) { call.filters.push({ op: "eq", column, value }); return q; },
      gte(column: string, value: unknown) { call.filters.push({ op: "gte", column, value }); return q; },
      gt(column: string, value: unknown) { call.filters.push({ op: "gt", column, value }); return q; },
      lte(column: string, value: unknown) { call.filters.push({ op: "lte", column, value }); return q; },
      lt(column: string, value: unknown) { call.filters.push({ op: "lt", column, value }); return q; },
      order(column: string, options?: { ascending?: boolean }) {
        call.order.push({ column, ascending: options?.ascending !== false });
        return q;
      },
      limit(n: number) { call.limit = n; return q; },
      range(from: number, to: number) { call.offset = from; call.limit = to - from + 1; return q; },
      or(filter: string) { call.after = keysetOf(filter); return q; },
      then<T>(resolve: (value: { data: SampleRow[]; error: null }) => T) {
        return Promise.resolve({ data: select(rows, call), error: null }).then(resolve);
      },
    };
    return q;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

/** `start_time.gt.<t>,and(start_time.eq.<t>,id.gt.<id>)` — the one continuation `rawSamples` sends. */
function keysetOf(filter: string): { time: string; id: string } {
  const match = /^start_time\.gt\.([^,]+),and\(start_time\.eq\.([^,]+),id\.gt\.([^)]+)\)$/
    .exec(filter);
  if (!match) throw new Error(`unsupported or() continuation: ${filter}`);
  return { time: match[2], id: match[3] };
}

function select(rows: SampleRow[], call: Call): SampleRow[] {
  let out = rows.filter((row) => call.filters.every((filter) =>
    compare((row as unknown as Record<string, unknown>)[filter.column], filter.value, filter.op,
      filter.column)));
  if (call.after) {
    const { time, id } = call.after;
    out = out.filter((row) => {
      const at = String(row.start_time), key = String(row.id);
      return at > time || (at === time && key > id);
    });
  }
  for (const { column, ascending } of [...call.order].reverse()) {
    out = [...out].sort((a, b) => {
      const x = String((a as unknown as Record<string, string>)[column] ?? "");
      const y = String((b as unknown as Record<string, string>)[column] ?? "");
      return ascending ? x.localeCompare(y) : y.localeCompare(x);
    });
  }
  const offset = call.offset ?? 0;
  return out.slice(offset, offset + Math.min(call.limit ?? MAX_ROWS, MAX_ROWS));
}
