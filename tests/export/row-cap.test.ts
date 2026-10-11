/**
 * W012: the export reads past the API's row cap and validates its cursors.
 *
 * PostgREST stops every response at `max_rows = 1000` (supabase/config.toml) without saying so,
 * whatever `.limit()` or `.range()` asked for. The double below applies every filter, order and
 * limit for real and then enforces that cap, so a stream that issued one select used to hand back
 * 1,000 rows and a null cursor for a 1,001-row history (A085, A112, A113, A071). It also records
 * every `.in()` list (A114: no request may carry more than `IN_CHUNK_SIZE` keys) and every `or()`
 * string (A126, A133: a cursor field must never reach the filter unchecked).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { TargetProfile } from "@/lib/api-types";

// lib/server/export.ts imports "server-only"; the marker package is stubbed, never the module.
vi.mock("server-only", () => ({}));

const { decodeCursor, encodeCursor, encodeTextCursor, streamFavorites, streamMeals, streamRecipes,
  streamWater } = await import("@/lib/server/export");
const { loadDayTypeOverrides, loadTargetProfiles, profileForDate }
  = await import("@/lib/server/export-targets");
const { decodeCursor: decodeUndoCursor } = await import("@/lib/server/coach-undo");
const { IN_CHUNK_SIZE } = await import("@/lib/server/paged-read");

const MAX_ROWS = 1000;
const USER = "00000000-0000-4000-8000-0000000000aa";
type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Call = { table: string; filters: Filter[]; order: { column: string; ascending: boolean }[];
  offset: number; limit: number | null; inSizes: number[]; or: string[] };

const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1
  : String(a ?? "") > String(b ?? "") ? 1 : 0;

/** The meals keyset `or()` — the only one the export sends. Anything else fails the test. */
function keyset(filter: string): Filter {
  const m = /^local_date\.gt\.([^,()]+),and\(local_date\.eq\.([^,()]+),eaten_at\.gt\.([^,()]+)\),and\(local_date\.eq\.([^,()]+),eaten_at\.eq\.([^,()]+),id\.gt\.([^,()]+)\)$/
    .exec(filter);
  if (!m) throw new Error(`unsupported or(): ${filter}`);
  const [d, t, id] = [m[1], m[3], m[6]];
  return (row) => cmp(row.local_date, d) > 0
    || (row.local_date === d && (cmp(row.eaten_at, t) > 0 || (row.eaten_at === t && cmp(row.id, id) > 0)));
}

function fakeDb(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, filters: [], order: [], offset: 0, limit: null, inSizes: [], or: [] };
    calls.push(call);
    const run = () => {
      let out = (tables[table] ?? []).filter((row) => call.filters.every((f) => f(row)));
      for (const { column, ascending } of [...call.order].reverse()) {
        out = [...out].sort((a, b) => (ascending ? 1 : -1) * cmp(a[column], b[column]));
      }
      const want = call.limit ?? Number.POSITIVE_INFINITY;
      return out.slice(call.offset, call.offset + Math.min(want, MAX_ROWS));
    };
    const q = {
      select: () => q,
      eq(c: string, v: unknown) { call.filters.push((r) => String(r[c]) === String(v)); return q; },
      is(c: string, v: unknown) { call.filters.push((r) => (r[c] ?? null) === v); return q; },
      gte(c: string, v: unknown) { call.filters.push((r) => cmp(r[c], v) >= 0); return q; },
      lte(c: string, v: unknown) { call.filters.push((r) => cmp(r[c], v) <= 0); return q; },
      gt(c: string, v: unknown) { call.filters.push((r) => cmp(r[c], v) > 0); return q; },
      in(c: string, vs: unknown[]) {
        call.inSizes.push(vs.length);
        const set = new Set(vs.map(String));
        call.filters.push((r) => set.has(String(r[c])));
        return q;
      },
      or(f: string) { call.or.push(f); call.filters.push(keyset(f)); return q; },
      order(column: string, o?: { ascending?: boolean }) {
        call.order.push({ column, ascending: o?.ascending !== false }); return q;
      },
      limit(n: number) { call.limit = n; return q; },
      range(a: number, z: number) { call.offset = a; call.limit = z - a + 1; return q; },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then<T>(resolve: (v: { data: Row[]; error: null }) => T, reject?: (e: unknown) => T) {
        return Promise.resolve().then(() => ({ data: run(), error: null })).then(resolve, reject);
      },
    };
    return q;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

const pad = (n: number, width = 12) => String(n).padStart(width, "0");
const uuid = (n: number) => `00000000-0000-4000-8000-${pad(n)}`;
const day = (n: number) => new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

/** One entry a day, each with one item that names a user food (no catalog read needed). */
function entries(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: uuid(i + 1), user_id: USER,
    local_date: day(Math.floor(i / 2)), eaten_at: `${day(Math.floor(i / 2))}T${i % 2 ? "18" : "08"}:00:00.000Z`,
    tz: "UTC", slot: "meal-1", note: null, deleted_at: null,
    log_items: [{ seq: 1, qty: 1, unit: "g", grams: 100, food_ref_id: uuid(90_000), food_revision_id: null,
      snapshot: {}, nutrition_partial: false }] }));
}
const REFS = [{ id: uuid(90_000), catalog_food_id: null, user_food_id: uuid(90_001),
  user_foods: { name: "Oats", brand: null } }];

describe("streamMeals past the row cap (A085, A112)", () => {
  it("returns all 1,001 entries with the default limit and no cursor", async () => {
    const { client, calls } = fakeDb({ log_entries: entries(1001), food_refs: REFS });
    const page = await streamMeals(client, USER, { limit: 5000 });
    expect(page.rows).toHaveLength(1001);
    expect(new Set(page.rows.map((r) => r.entry_id)).size).toBe(1001);
    expect(page.next_cursor).toBeNull();
    // Every request stays within the cap, so none was silently cut.
    for (const c of calls.filter((c) => c.table === "log_entries")) {
      expect(c.limit).toBeLessThanOrEqual(MAX_ROWS);
    }
  });

  it("stops at the limit with a real cursor, and the cursor reaches the rest", async () => {
    const { client } = fakeDb({ log_entries: entries(2601), food_refs: REFS });
    const first = await streamMeals(client, USER, { limit: 2500 });
    expect(first.rows).toHaveLength(2500);
    expect(first.next_cursor).not.toBeNull();
    const second = await streamMeals(client, USER, { limit: 2500, cursor: first.next_cursor! });
    expect(second.rows).toHaveLength(101);
    expect(second.next_cursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r) => r.entry_id);
    expect(new Set(ids).size).toBe(2601);
  });

  it("gives a cursor when exactly the limit is 1,000 and one more entry exists", async () => {
    const { client } = fakeDb({ log_entries: entries(1001), food_refs: REFS });
    const page = await streamMeals(client, USER, { limit: 1000 });
    expect(page.rows).toHaveLength(1000);
    expect(page.next_cursor).not.toBeNull();
  });
});

describe("streamRecipes, streamWater and streamFavorites past the row cap (A113)", () => {
  it("returns all 1,001 recipes", async () => {
    const recipes = Array.from({ length: 1001 }, (_, i) => ({ id: uuid(i + 1), user_id: USER,
      name: `Recipe ${i}`, servings: 1, deleted_at: null, recipe_revisions: [{ id: uuid(50_000 + i),
        rev: 1, created_at: "2026-01-01T00:00:00Z", nutrients_per_serving: {},
        recipe_items: [{ seq: 1, grams: 10, food_ref_id: uuid(90_000) }] }] }));
    const { client } = fakeDb({ recipes, food_refs: REFS });
    const page = await streamRecipes(client, USER, { limit: 5000 });
    expect(new Set(page.rows.map((r) => r.recipe_id)).size).toBe(1001);
    expect(page.next_cursor).toBeNull();
  });

  it("returns all 1,001 water days, with chunked override lookups", async () => {
    const water = Array.from({ length: 1001 }, (_, i) => ({ user_id: USER, local_date: day(i), cups: 4 }));
    const { client, calls } = fakeDb({ water_log: water, user_settings: [{ user_id: USER }],
      plan_days: [{ user_id: USER, local_date: day(1000), day_type_override: "training-10" }] });
    const page = await streamWater(client, USER, { limit: 5000 });
    expect(page.rows).toHaveLength(1001);
    expect(page.rows.at(-1)!.local_date).toBe(day(1000));
    expect(page.next_cursor).toBeNull();
    // The last day's lock is read (A114): it is past the first `.in()` chunk.
    expect(page.rows.at(-1)!.goal).toBe(page.rows.at(-1)!.goal_training_cups);
    const sizes = calls.filter((c) => c.table === "plan_days").flatMap((c) => c.inSizes);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(IN_CHUNK_SIZE);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it("returns all 1,001 favorite foods", async () => {
    const favorites = Array.from({ length: 1001 }, (_, i) => ({ user_id: USER, food_ref_id: uuid(i + 1),
      sort: i, created_at: "2026-01-01T00:00:00Z", deleted_at: null }));
    const refs = favorites.map((f) => ({ id: f.food_ref_id, catalog_food_id: null, user_food_id: null,
      user_foods: { name: `Food ${f.food_ref_id}` } }));
    const { client, calls } = fakeDb({ favorites_foods: favorites, favorites_recipes: [],
      favorites_meals: [], food_refs: refs });
    const page = await streamFavorites(client, USER, { limit: 5000 });
    expect(page.rows).toHaveLength(1001);
    expect(page.rows.every((r) => r.name.startsWith("Food "))).toBe(true);
    const sizes = calls.filter((c) => c.table === "food_refs").flatMap((c) => c.inSizes);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(IN_CHUNK_SIZE);
  });
});

function profile(rev: number, effectiveFrom: string, weekdays: number[], weightKg: number): TargetProfile {
  return { id: uuid(70_000 + rev), user_id: USER, effective_from: effectiveFrom, rev,
    kcal_train: 2200, kcal_rest: 2000, authored_by: "user", mode: "grams", protein_g: 120,
    fat_g: 70, carb_g: 200, protein_pct: null, fat_pct: null, carb_pct: null, kcal_min: 1200,
    protein_g_min: 100, fat_g_min: 40, carb_g_min: 0, goal_rate_bp_week: 0,
    max_weekly_kcal_step: 150, notes: null, target_source: "derived",
    training_macros: { kcal: 2200, protein: 120, carbs: 250, fat: 70 },
    rest_macros: { kcal: 2000, protein: 120, carbs: 200, fat: 70 },
    pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null, input_weight_kg: weightKg,
    input_weight_source: "weigh-in", input_training_weekdays: weekdays,
    input_activity_level: "moderate", input_goal: "recomp", formula_name: "profile-energy-v1",
  } as TargetProfile;
}

describe("target revisions and day-type overrides (A071, A114)", () => {
  it("reads all 1,001 revisions, so the newest is the one in force on the last date", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => profile(i + 1, day(i), [1], 60));
    const { client } = fakeDb({ target_profiles: rows as unknown as Row[] });
    const loaded = await loadTargetProfiles(client, USER, day(2000));
    expect(loaded).toHaveLength(1001);
    expect(profileForDate(loaded, day(1500))?.rev).toBe(1001);
  });

  it("chunks a 1,100-date override lookup and returns every lock", async () => {
    const dates = Array.from({ length: 1100 }, (_, i) => day(i));
    const { client, calls } = fakeDb({ plan_days: dates.map((d) => ({ user_id: USER,
      local_date: d, day_type_override: "rest" })) });
    const overrides = await loadDayTypeOverrides(client, USER, dates);
    expect(overrides.size).toBe(1100);
    const sizes = calls.flatMap((c) => c.inSizes);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(IN_CHUNK_SIZE);
  });
});

describe("water uses each date's own revision (A052)", () => {
  it("judges August by August's weekdays and weight, and September by September's", async () => {
    // Rev 1 (from Aug 1): Mondays train, 60 kg. Rev 2 (from Sep 1): Tuesdays train, 90 kg.
    // The profile now says Tuesday, and the newest weight is 90 kg.
    const { client } = fakeDb({
      water_log: ["2026-08-03", "2026-08-04", "2026-09-07", "2026-09-08"].map((d) =>
        ({ user_id: USER, local_date: d, cups: 4 })),
      user_settings: [{ user_id: USER, training_weekdays: [2], weight_kg: 90 }],
      target_profiles: [profile(1, "2026-08-01", [1], 60), profile(2, "2026-09-01", [2], 90)] as
        unknown as Row[],
    });
    const page = await streamWater(client, USER, { limit: 50 });
    const goal = Object.fromEntries(page.rows.map((r) => [r.local_date, r.goal]));
    // 60 kg: 0.6 fl oz/lb ≈ 79 oz ≈ 10 cups, +2 on a training day. 90 kg ≈ 119 oz ≈ 15 cups.
    expect(goal["2026-08-03"]).toBe(12);  // Monday, a training day under rev 1, at 60 kg
    expect(goal["2026-08-04"]).toBe(10);  // Tuesday, a rest day under rev 1, at 60 kg
    expect(goal["2026-09-07"]).toBe(15);  // Monday, a rest day under rev 2, at 90 kg
    expect(goal["2026-09-08"]).toBe(17);  // Tuesday, a training day under rev 2, at 90 kg
  });
});

describe("cursor validation (A126, A133)", () => {
  const raw = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const good = { local_date: "2026-09-17", eaten_at: "2026-09-18T02:30:00.000Z", id: uuid(11) };

  it("accepts a cursor the export itself wrote, including Postgres's offset form", () => {
    expect(decodeCursor(encodeCursor(good))).toEqual(good);
    const pg = { ...good, eaten_at: "2026-09-18T02:30:00.123456+00:00" };
    expect(decodeCursor(encodeCursor(pg))).toEqual(pg);
    expect(decodeCursor(raw({ local_date: "2026-09-17", eaten_at: "", id: "" })).local_date)
      .toBe("2026-09-17");
  });

  it.each([
    ["a non-date local_date", { ...good, local_date: "x" }],
    ["an impossible date", { ...good, local_date: "2026-02-30" }],
    ["or() grammar in local_date", { ...good, local_date: "x),y" }],
    ["a free-text eaten_at", { ...good, eaten_at: "z" }],
    ["or() grammar in id", { ...good, id: "z),and(local_date.gte.1900-01-01" }],
  ])("rejects %s with a 422 before any query runs", async (_name, cursor) => {
    expect(() => decodeCursor(raw(cursor))).toThrow(/malformed cursor/);
    const { client, calls } = fakeDb({ log_entries: entries(3), food_refs: REFS });
    await expect(streamMeals(client, USER, { limit: 10, cursor: raw(cursor) }))
      .rejects.toMatchObject({ status: 422 });
    expect(calls.filter((c) => c.table === "log_entries")).toHaveLength(0);
  });

  it("rejects a progress-shaped cursor on the meals keyset", async () => {
    const { client } = fakeDb({ log_entries: entries(3), food_refs: REFS });
    await expect(streamMeals(client, USER, { limit: 10,
      cursor: raw({ local_date: "2026-09-17", eaten_at: "", id: "" }) }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("rejects a recipes cursor that is not a uuid, and a water cursor that is not a date", async () => {
    const { client, calls } = fakeDb({});
    await expect(streamRecipes(client, USER, { limit: 10, cursor: encodeTextCursor("abc") }))
      .rejects.toMatchObject({ status: 422 });
    await expect(streamWater(client, USER, { limit: 10, cursor: encodeTextCursor("2026-13-45") }))
      .rejects.toMatchObject({ status: 422 });
    expect(calls.filter((c) => c.table === "recipes" || c.table === "water_log")).toHaveLength(0);
  });

  it("takes only a strict ISO instant in the coach-undo cursor", () => {
    expect(decodeUndoCursor(`2026-10-01T12:00:00.123456+00:00,${uuid(1)}`)).not.toBeNull();
    expect(decodeUndoCursor(`Thu, 01 Jan 2026 00:00:00 GMT,${uuid(1)}`)).toBeNull();
    expect(decodeUndoCursor(`2026-10-01,${uuid(1)}`)).toBeNull();
  });
});

describe("fetchUpTo", () => {
  it("rejects the whole read when any request fails, never a partial set", async () => {
    const { fetchUpTo } = await import("@/lib/server/paged-read");
    let calls = 0;
    await expect(fetchUpTo<number>(2500, async (_after, size) => {
      calls += 1;
      return calls === 1 ? { data: Array.from({ length: size }, (_, i) => i), error: null }
        : { data: null, error: { message: "boom" } };
    })).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
});
