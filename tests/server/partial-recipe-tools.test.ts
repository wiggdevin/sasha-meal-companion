/**
 * Review round 9: the coach's get_day / get_week_totals and the progress export carry the #21
 * caveats, and a day whose only item has an empty snapshot (no daily_totals row) still exports.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { dayTotalsWithCaveats } = await import("@/lib/server/day-totals");
const { streamProgress } = await import("@/lib/server/export");

type Row = Record<string, unknown>;
const USER = "u1";

/** A filtering PostgREST stand-in (eq/is/in/gte/lte/order/limit), with optional failing reads. */
function fakeClient(tables: Record<string, Row[]>, opts: { failRefsKind?: boolean } = {}) {
  const rpc = vi.fn(async () => ({ data: [], error: null }));
  const from = vi.fn((table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let cap: number | undefined;
    let offset = 0;
    let desc = false;
    let columns = "";
    const keep = (col: string, test: (v: unknown) => boolean) =>
      filters.push((row) => !(col in row) || test(row[col]));
    const result = () => {
      if (opts.failRefsKind && table === "food_refs" && columns.includes("user_foods(kind)")) {
        return { data: null, error: new Error("food_refs unavailable") };
      }
      let rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      if (desc) rows = [...rows].reverse();
      // The API's own row cap (supabase/config.toml max_rows = 1000), applied to every answer.
      const capped = rows.slice(offset).slice(0, Math.min(cap ?? Infinity, 1000));
      return { data: capped, error: null };
    };
    const builder: Record<string, unknown> = {
      select: (cols = "") => { columns = cols; return builder; },
      order: (_c: string, o?: { ascending?: boolean }) => { desc = o?.ascending === false; return builder; },
      or: () => builder, not: () => builder,
      eq: (col: string, v: unknown) => { keep(col, (x) => x === v); return builder; },
      is: (col: string, v: unknown) => { keep(col, (x) => x === v); return builder; },
      in: (col: string, vs: unknown[]) => { keep(col, (x) => vs.includes(x)); return builder; },
      gte: (col: string, v: string) => { keep(col, (x) => String(x) >= v); return builder; },
      lte: (col: string, v: string) => { keep(col, (x) => String(x) <= v); return builder; },
      gt: (col: string, v: string) => { keep(col, (x) => String(x) > v); return builder; },
      limit: (n: number) => { cap = n; return builder; },
      // W012: the export reads its whole-set tables a `.range()` page at a time.
      range: (a: number, b: number) => { offset = a; cap = b - a + 1; return builder; },
      maybeSingle: async () => ({ data: (result().data ?? [])[0] ?? null, error: null }),
      then: (resolve: (value: ReturnType<typeof result>) => unknown,
        reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  });
  return { from, rpc } as never;
}

const entry = (id: string, date: string, nutrition_partial: boolean | null, ref = "ref-1") => ({
  id, user_id: USER, local_date: date, deleted_at: null, eaten_at: `${date}T12:00:00Z`,
  log_items: [{ food_ref_id: ref, nutrition_partial }] });

describe("coach get_day / get_week_totals caveats", () => {
  it("flags a day with a recorded partial recipe serving as a lower bound", async () => {
    const client = fakeClient({ log_entries: [entry("e1", "2026-10-01", true), entry("e2", "2026-10-02", false)] });
    const [one, two] = await dayTotalsWithCaveats(client, USER, ["2026-10-01", "2026-10-02"]);
    expect(one).toMatchObject({ energy_is_lower_bound: true, partial_recipe_items: 1 });
    expect(two).not.toHaveProperty("energy_is_lower_bound");
    expect(two).not.toHaveProperty("nutrition_unchecked");
  });

  it("says nutrition_unchecked when the check could not run", async () => {
    const client = fakeClient({ log_entries: [entry("e1", "2026-10-01", null)] }, { failRefsKind: true });
    const [day] = await dayTotalsWithCaveats(client, USER, ["2026-10-01"]);
    expect(day).toMatchObject({ nutrition_unchecked: true });
    expect(day).not.toHaveProperty("energy_is_lower_bound");
  });
});

describe("progress export with an empty-snapshot day", () => {
  it("exports a logged date that has no daily_totals row, with its partial count", async () => {
    const client = fakeClient({
      // 2026-10-01 has totals; 2026-10-02's only item is an empty-snapshot partial recipe serving.
      daily_totals: [{ user_id: USER, local_date: "2026-10-01", nutrient_code: "protein", amount: 10,
        items_with_value: 1, items_total: 1, coverage: 1 }],
      log_entries: [entry("e1", "2026-10-01", false), entry("e2", "2026-10-02", true)],
      user_settings: [], plan_days: [], target_profiles: [],
    });
    const { rows } = await streamProgress(client, USER, { from: "2026-10-01", to: "2026-10-03", limit: 10 });
    expect(rows.map((row) => [row.local_date, row.items_logged, row.partial_recipe_items])).toEqual([
      ["2026-10-01", 1, 0], ["2026-10-02", 1, 1]]);
    expect(rows[1]).toMatchObject({ protein_g: null, energy_kcal: null });
  });

  it("closes an open window at the first and last logged dates", async () => {
    const client = fakeClient({ daily_totals: [],
      log_entries: [entry("e1", "2026-09-30", true), entry("e2", "2026-10-02", null)],
      user_settings: [], plan_days: [], target_profiles: [] });
    const { rows } = await streamProgress(client, USER, { limit: 10 });
    expect(rows.map((row) => row.local_date)).toEqual(["2026-09-30", "2026-10-02"]);
  });
});

describe("progress export past the 1,000-row cap (review round 10 probe)", () => {
  const day = (i: number) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
  const CODES = ["energy_kcal", "energy_kcal_calc", "protein", "carbohydrate", "fat_total", "fiber_total",
    "iron", "calcium", "sodium", "potassium", "magnesium", "zinc", "vitamin_c", "vitamin_d",
    "vitamin_a", "folate", "vitamin_b12", "sugars_total", "fat_saturated", "cholesterol"];
  const tables = () => ({
    // 60 dates x 20 codes = 1,200 rows: more than one capped read can return.
    daily_totals: Array.from({ length: 60 }, (_, i) => CODES.map((code) => ({ user_id: USER,
      local_date: day(i), nutrient_code: code, amount: code === "protein" ? 42 : 1,
      items_with_value: 1, items_total: 1, coverage: 1 }))).flat(),
    log_entries: Array.from({ length: 60 }, (_, i) => entry(`e${i}`, day(i), false)),
    user_settings: [], plan_days: [], target_profiles: [],
  });

  it("exports every day's real totals, day 51 included, with no cursor when all fit", async () => {
    const { rows, next_cursor } = await streamProgress(fakeClient(tables()), USER,
      { from: day(0), to: day(59), limit: 100 });
    expect(rows).toHaveLength(60);
    expect(rows.every((row) => row.protein_g === 42)).toBe(true);
    expect(rows[50]).toMatchObject({ local_date: day(50), protein_g: 42, items_logged: 1 });
    expect(next_cursor).toBeNull();
  });

  it("pages by logged dates: a full page carries a cursor and the next page continues after it", async () => {
    const client = fakeClient(tables());
    const first = await streamProgress(client, USER, { from: day(0), to: day(59), limit: 25 });
    expect(first.rows.map((row) => row.local_date)).toEqual(Array.from({ length: 25 }, (_, i) => day(i)));
    expect(first.next_cursor).not.toBeNull();
    const second = await streamProgress(client, USER, { from: day(0), to: day(59), limit: 25,
      cursor: first.next_cursor! });
    expect(second.rows[0].local_date).toBe(day(25));
    expect(second.rows.every((row) => row.protein_g === 42)).toBe(true);
  });
});

describe("unchecked is per day (review round 10 warning)", () => {
  it("marks only the day whose items the failed read left unjudged", async () => {
    const client = fakeClient({ log_entries: [entry("e1", "2026-10-01", null)] }, { failRefsKind: true });
    const [one, two] = await dayTotalsWithCaveats(client, USER, ["2026-10-01", "2026-10-02"]);
    expect(one).toMatchObject({ nutrition_unchecked: true });
    expect(two).not.toHaveProperty("nutrition_unchecked");
  });
});
