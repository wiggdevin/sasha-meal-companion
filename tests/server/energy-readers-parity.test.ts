/**
 * Calculation audit 2026-10-05, findings 17-19: every reader of a logged day's calories applies
 * the one per-item rule (lib/nutrients/energy.ts) — reported, else calculated, else unknown.
 *
 * The fixture day has three items: 100 reported kcal (with a 95 calculated sibling), a reported
 * object with a null amount and 80 calculated kcal, and an item with no energy at all. Every
 * reader must say 180 for the day. `daily_totals`' reported-only energy row (100) is served too,
 * so a reader that still uses it fails here.
 *
 * The `daily_energy` row below is what migration 20261210090000 returns for these three snapshots
 * (checked on Postgres 16: amount 180, 2 of 3 items, coverage 0.6667, 1 reported, 1 calculated).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { loggedEntries, toDayContext } = await import("@/lib/server/day-context");
const { streamMeals, streamProgress } = await import("@/lib/server/export");
const { flattenMeals } = await import("@/lib/server/export-meals");
const { dayTotals, dayTotalsPrivileged } = await import("@/lib/server/day-totals");
const { runEstimate } = await import("@/lib/server/expenditure");
const { entryMacros, resolveDay } = await import("@/lib/resolve");
const { defaultSettings } = await import("@/lib/store");
const { energyTotal } = await import("@/lib/nutrients/energy");
const { estimateExpenditure } = await import("@/lib/expenditure");

vi.mock("@/lib/expenditure", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/expenditure")>();
  return { ...real, estimateExpenditure: vi.fn(real.estimateExpenditure) };
});

type Row = Record<string, unknown>;

const USER = "u1";
const DATE = "2026-10-01";

const nv = (amount: number | null, unit = "kcal") => ({ amount, unit, basis: "per_100g",
  source: "usda", source_version: "2024-10", revision_id: 7 });

const SNAPSHOTS = [
  { energy_kcal: nv(100), energy_kcal_calc: nv(95), protein: nv(10, "g") },
  { energy_kcal: nv(null), energy_kcal_calc: nv(80), protein: nv(4, "g") },
  { protein: nv(5, "g") },
];

const ENTRY: Row = {
  id: "e1", user_id: USER, local_date: DATE, eaten_at: `${DATE}T12:00:00Z`, tz: "UTC",
  slot: "snack", note: null, deleted_at: null,
  log_items: SNAPSHOTS.map((snapshot, i) => ({ seq: i + 1, qty: 100, unit: "g", grams: 100,
    food_ref_id: `r${i + 1}`, food_revision_id: 7, snapshot })),
};

const DAILY_ENERGY: Row = { user_id: USER, local_date: DATE, amount: 180, items_with_value: 2,
  items_total: 3, coverage: 0.6667, reported_items: 1, calculated_items: 1 };

const DAILY_TOTALS: Row[] = [
  // Reported-only: what the old readers summed. No reader may surface it as the day's kcal.
  { user_id: USER, local_date: DATE, nutrient_code: "energy_kcal", amount: 100,
    items_with_value: 1, items_total: 3, coverage: 0.3333 },
  { user_id: USER, local_date: DATE, nutrient_code: "energy_kcal_calc", amount: 175,
    items_with_value: 2, items_total: 3, coverage: 0.6667 },
  { user_id: USER, local_date: DATE, nutrient_code: "protein", amount: 19,
    items_with_value: 3, items_total: 3, coverage: 1 },
];

const PROFILE = { user_id: USER, sex: "female", birth_year: 1996, height_cm: 165, weight_kg: 60,
  body_fat_pct: null, activity_level: "moderate", time_zone: "UTC" };

/** A filtering PostgREST stand-in: eq/is/in/gte/lte filter, the rest pass through. */
function fakeClient(tables: Record<string, Row[]>, rpcs: Record<string, Row[]> = {}) {
  const rpc = vi.fn(async (name: string) => ({ data: rpcs[name] ?? [], error: null }));
  const from = vi.fn((table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let cap: number | undefined;
    const keep = (col: string, test: (v: unknown) => boolean) =>
      filters.push((row) => !(col in row) || test(row[col]));
    const result = () => {
      const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      return { data: cap === undefined ? rows : rows.slice(0, cap), error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder, order: () => builder, or: () => builder, not: () => builder,
      eq: (col: string, v: unknown) => { keep(col, (x) => x === v); return builder; },
      is: (col: string, v: unknown) => { keep(col, (x) => x === v); return builder; },
      in: (col: string, vs: unknown[]) => { keep(col, (x) => vs.includes(x)); return builder; },
      gte: (col: string, v: string) => { keep(col, (x) => String(x) >= v); return builder; },
      lte: (col: string, v: string) => { keep(col, (x) => String(x) <= v); return builder; },
      limit: (n: number) => { cap = n; return builder; },
      maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
      then: (resolve: (value: ReturnType<typeof result>) => unknown,
        reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  });
  return { client: { from, rpc } as never, from, rpc };
}

const TABLES = {
  log_entries: [ENTRY],
  food_refs: SNAPSHOTS.map((_, i) => ({ id: `r${i + 1}`, catalog_food_id: null,
    user_food_id: `f${i + 1}`, user_foods: { name: `Food ${i + 1}`, brand: null } })),
  daily_energy: [DAILY_ENERGY],
  daily_totals: DAILY_TOTALS,
  user_settings: [PROFILE],
  plan_days: [],
  target_profiles: [],
};

describe("one energy rule across every reader (audit findings 17-19)", () => {
  it("coach items: the calculated-only item reads 80 kcal and the unknown item '? kcal'", async () => {
    const { client } = fakeClient(TABLES);
    const logged = await loggedEntries(client, USER, DATE);
    const items = logged[0].entry.items ?? [];
    expect(items.map((item) => item.macros.kcal)).toEqual([100, 80, 0]);
    const store = { version: 1, firstOpenedAt: `${DATE}T00:00:00.000Z`,
      settings: defaultSettings(), foods: {},
      days: { [DATE]: { date: DATE, extras: logged.map(({ entry }) => entry) } } } as never;
    const context = toDayContext(resolveDay(store, DATE), "UTC", logged);
    expect(context.entries[0].items).toEqual([
      "100 g Food 1 - 100 kcal 10P 0C 0F",
      "100 g Food 2 - 80 kcal 4P 0C 0F",
      "100 g Food 3 - ? kcal 5P 0C 0F",
    ]);
    expect(context.entries[0].macros.startsWith("180 kcal")).toBe(true);
  });

  it("meal export: 80 calculated kcal is exported with its source, the unknown item stays blank",
    async () => {
      const { client } = fakeClient(TABLES);
      const { rows } = await streamMeals(client, USER, { limit: 100 });
      expect(rows.map((row) => [row.energy_kcal, row.energy_kcal_source])).toEqual([
        [100, "reported"], [80, "calculated"], [null, null]]);
      expect(flattenMeals([ENTRY as never]).map((row) => row.energy_kcal)).toEqual([100, 80, null]);
    });

  it("progress export: the day's energy is the per-item selection, marked mixed", async () => {
    const { client } = fakeClient(TABLES);
    const { rows } = await streamProgress(client, USER, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ local_date: DATE, energy_kcal: 180,
      energy_kcal_source: "mixed", protein_g: 19 });
  });

  it("day totals (log response, MCP get_day, coach): energy_kcal is the selected 180", async () => {
    const { client } = fakeClient(TABLES, {
      get_daily_totals: DAILY_TOTALS, get_daily_energy: [DAILY_ENERGY] });
    for (const totals of [await dayTotals(client, USER, DATE),
      await dayTotalsPrivileged(client, USER, DATE)]) {
      expect(totals.nutrients.find((n) => n.code === "energy_kcal")).toMatchObject({
        amount: 180, itemsWithValue: 2, itemsTotal: 3, coverage: 0.6667 });
      expect(totals.nutrients.find((n) => n.code === "protein")?.amount).toBe(19);
    }
  });

  it("day totals: the selected energy keeps energy_kcal's place in the list (T9 §2 shape)",
    async () => {
      const { client } = fakeClient(TABLES);
      const codes = (await dayTotals(client, USER, DATE)).nutrients.map((n) => n.code);
      expect(codes).toEqual(["energy_kcal", "energy_kcal_calc", "protein"]);
    });

  it("day totals: no usable energy keeps the unmeasured row (coverage 0), never a 0 with coverage",
    async () => {
      const { client } = fakeClient({ ...TABLES,
        daily_totals: [{ ...DAILY_TOTALS[0], amount: null, items_with_value: 0, coverage: 0 },
          ...DAILY_TOTALS.slice(1)],
        daily_energy: [{ ...DAILY_ENERGY, amount: null, items_with_value: 0, coverage: 0,
          reported_items: 0, calculated_items: 0 }] });
      const totals = await dayTotals(client, USER, DATE);
      expect(totals.nutrients.find((n) => n.code === "energy_kcal"))
        .toMatchObject({ amount: 0, itemsWithValue: 0, coverage: 0 });
    });

  it("parity: coach day kcal == sum of entry kcal == export energy == expenditure intake", async () => {
    const { client } = fakeClient(TABLES);

    const logged = await loggedEntries(client, USER, DATE);
    const entryKcal = logged.reduce((sum, { entry }) => sum + entryMacros(entry).kcal, 0);
    const store = { version: 1, firstOpenedAt: `${DATE}T00:00:00.000Z`,
      settings: defaultSettings(), foods: {},
      days: { [DATE]: { date: DATE, extras: logged.map(({ entry }) => entry) } } } as never;
    const coachDayKcal = toDayContext(resolveDay(store, DATE), "UTC", logged).consumed.kcal;

    const meals = await streamMeals(client, USER, { limit: 100 });
    const mealExportKcal = meals.rows.reduce((sum, row) => sum + (row.energy_kcal ?? 0), 0);
    const progress = await streamProgress(client, USER, { limit: 10 });

    vi.mocked(estimateExpenditure).mockClear();
    await runEstimate(client, USER, "2026-10-02", { weighIns: async () => [] });
    const intake = vi.mocked(estimateExpenditure).mock.calls[0][0].intake;

    const rule = energyTotal(SNAPSHOTS).kcal;
    expect(rule).toBe(180);
    expect({ coachDayKcal, entryKcal, mealExportKcal,
      progressKcal: progress.rows[0].energy_kcal, intakeKcal: intake[0]?.kcal })
      .toEqual({ coachDayKcal: 180, entryKcal: 180, mealExportKcal: 180, progressKcal: 180,
        intakeKcal: 180 });
  });
});
