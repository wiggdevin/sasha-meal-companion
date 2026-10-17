/**
 * TDEE step F (docs/plans/2026-09-22-tdee-engine-plan.md §F) and spec acceptance 10, on the server
 * path (lib/server/expenditure.ts `runEstimate`): a goal or rate change on the revision or the
 * profile never moves the estimate, and one account's seed never reaches another's estimate.
 * handoff.test.ts proves the pure engine takes no goal; this proves the server hands it none.
 */
import { describe, expect, it, vi } from "vitest";
import { runEstimate } from "@/lib/server/expenditure";
import { estimateExpenditure, fromDayNumber, toDayNumber } from "@/lib/expenditure";

vi.mock("@/lib/expenditure", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/expenditure")>();
  return { ...real, estimateExpenditure: vi.fn(real.estimateExpenditure) };
});

type Row = Record<string, unknown>;
const AS_OF = "2026-09-11";

/** An in-memory PostgREST stand-in that really filters by user_id, dates, `in` and `is`. */
function table(rows: Row[]) {
  const filters: ((row: Row) => boolean)[] = [];
  let sort: { col: string; ascending: boolean }[] = [];
  let cap = Infinity;
  const result = () => {
    let out = rows.filter((row) => filters.every((f) => f(row)));
    for (const { col, ascending } of [...sort].reverse()) {
      out = [...out].sort((a, b) => (ascending ? 1 : -1)
        * String(a[col]).localeCompare(String(b[col]), "en", { numeric: true }));
    }
    return out.slice(0, cap);
  };
  const builder = {
    select: () => builder,
    eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return builder; },
    gte: (col: string, v: string) => { filters.push((r) => String(r[col]) >= v); return builder; },
    lte: (col: string, v: string) => { filters.push((r) => String(r[col]) <= v); return builder; },
    in: (col: string, v: unknown[]) => { filters.push((r) => v.includes(r[col])); return builder; },
    is: (col: string, v: unknown) => { filters.push((r) => (r[col] ?? null) === v); return builder; },
    not: (col: string) => { filters.push((r) => r[col] != null); return builder; },
    order: (col: string, { ascending }: { ascending: boolean }) => {
      sort = [...sort, { col, ascending }]; return builder; },
    limit: (n: number) => { cap = n; return builder; },
    maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: result(), error: null }),
  };
  return builder;
}

function database(tables: Record<string, Row[]>) {
  const rpc = vi.fn().mockResolvedValue({ data: "e1", error: null });
  const from = vi.fn((name: string) => table(tables[name] ?? []));
  return { admin: { from, rpc } as never, rpc };
}

/** 40 complete days at `kcal` and a slow loss, for `user`. */
function history(user: string, kcal: number) {
  const energy: Row[] = [];
  const weights: { date: string; kg: number }[] = [];
  for (let d = 40; d >= 1; d -= 1) {
    const date = fromDayNumber(toDayNumber(AS_OF) - d);
    energy.push({ user_id: user, local_date: date, amount: kcal, coverage: 1,
      items_with_value: 3, items_total: 3, reported_items: 3, calculated_items: 0 });
    weights.push({ date, kg: 70 - (40 - d) * 0.02 });
  }
  return { energy, weights };
}

const profile = (user: string, over: Row = {}): Row => ({ user_id: user, sex: "female",
  birth_year: 1990, height_cm: 168, weight_kg: 70, body_fat_pct: null, activity_level: "light",
  goal: "maintain", goal_rate_bp_week: 0, time_zone: "UTC", ...over });

const revision = (user: string, over: Row = {}): Row => ({ user_id: user, id: `${user}-r1`,
  rev: 1, effective_from: "2026-07-01", source: "derived", goal: "maintain",
  goal_rate_bp_week: 0, initial_tdee_kcal: 1900, bmr_kcal: 1450, bmr_method: "mifflin",
  activity_model_version: "activity-2026-09-22", derivation_version: "derive-2026-10-04",
  ...over });

describe("step F / acceptance 10 — goal and rate never reach the estimate (server path)", () => {
  it.each([
    ["lose_fat", -50], ["lose_fat", -75], ["gain_muscle", 20], ["recomp", 0],
  ] as const)("a revision and profile at %s %s bp give the maintain estimate", async (goal, bp) => {
    const { energy, weights } = history("u1", 1850);
    const weighIns = vi.fn(async () => weights);
    const run = (over: Row) => runEstimate(database({
      user_settings: [profile("u1", over)], target_profiles: [revision("u1", over)],
      daily_energy: energy,
    }).admin, "u1", AS_OF, { weighIns });
    const maintain = await run({});
    const changed = await run({ goal, goal_rate_bp_week: bp });
    expect(maintain).toMatchObject({ status: "estimating", seedSource: "revision" });
    expect(changed).toEqual(maintain);
  });

  it("a later revision that changes only goal and rate keeps the same frozen seed and estimate",
    async () => {
      const { energy, weights } = history("u1", 1850);
      const weighIns = vi.fn(async () => weights);
      vi.mocked(estimateExpenditure).mockClear();
      const one = await runEstimate(database({ user_settings: [profile("u1")],
        target_profiles: [revision("u1")], daily_energy: energy }).admin, "u1", AS_OF,
      { weighIns });
      const two = await runEstimate(database({ user_settings: [profile("u1")],
        target_profiles: [revision("u1"), revision("u1", { id: "u1-r2", rev: 2,
          effective_from: "2026-09-01", goal: "lose_fat", goal_rate_bp_week: -50 })],
        daily_energy: energy }).admin, "u1", AS_OF, { weighIns });
      expect(two).toEqual(one);
      const inputs = vi.mocked(estimateExpenditure).mock.calls.map(([input]) => input);
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toEqual(inputs[0]);
      expect(Object.keys(inputs[0]).sort()).toEqual(["activityContext", "asOf", "bmrKcal",
        "intake", "marksStartedOn", "seedKcal", "weighIns"]);
    });
});

describe("step F — no seed leaks between accounts", () => {
  it("two accounts in one database each get their own seed, in either order", async () => {
    const a = history("ua", 2000);
    const b = history("ub", 2000);
    const tables = {
      user_settings: [profile("ua"), profile("ub", { height_cm: 185, weight_kg: 95,
        sex: "male", activity_level: "active" })],
      // Account A has a frozen seed; account B has none and reads its own live profile.
      target_profiles: [revision("ua")],
      daily_energy: [...a.energy, ...b.energy],
    };
    const weighIns = vi.fn(async (_admin: unknown, user: string) =>
      (user === "ua" ? a.weights : b.weights));
    vi.mocked(estimateExpenditure).mockClear();
    const firstA = await runEstimate(database(tables).admin, "ua", AS_OF, { weighIns });
    const firstB = await runEstimate(database(tables).admin, "ub", AS_OF, { weighIns });
    const againA = await runEstimate(database(tables).admin, "ua", AS_OF, { weighIns });
    const seeds = vi.mocked(estimateExpenditure).mock.calls
      .map(([input]) => [input.seedKcal, input.bmrKcal]);
    // Male, 36 y, 185 cm, 95 kg: Mifflin 950 + 1,156.25 − 180 + 5 = 1,931.25; × 1.55 = 2,993.
    expect(seeds).toEqual([[1900, 1450], [2993, 1931], [1900, 1450]]);
    expect(firstA).toMatchObject({ seedSource: "revision" });
    expect(firstB).toMatchObject({ seedSource: "live_profile" });
    expect(againA).toEqual(firstA);
    // Identical observations, different seeds: different numbers until the fade completes.
    expect(firstB.tdeeKcal).not.toBe(firstA.tdeeKcal);
  });
});
