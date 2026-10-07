import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  HELD_WITHOUT_PROFILE_REASON, latestEstimate, runEstimate, timeZoneFor,
} from "@/lib/server/expenditure";
import { ENGINE_VERSION, estimateExpenditure } from "@/lib/expenditure";

// A pass-through spy, so a test can see the seed and the BMR the server hands the engine.
vi.mock("@/lib/expenditure", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/expenditure")>();
  return { ...real, estimateExpenditure: vi.fn(real.estimateExpenditure) };
});

/** A complete profile row: the engine seeds from THIS account, never a constant
 *  (Devin, 2026-09-22). Mifflin 1,320 × 1.40 = 1,848 kcal. No `day_marks_started_on`, so the
 *  account has never marked a day (R3) and coverage-qualified days count. */
const PROFILE = { sex: "female", birth_year: 1996, height_cm: 165, weight_kg: 60,
  body_fat_pct: null, activity_level: "moderate", time_zone: "America/Denver" };

const totalsRows = (days: number) => {
  const rows: Record<string, unknown>[] = [];
  for (let d = days; d >= 1; d -= 1) {
    const date = new Date(Date.UTC(2026, 8, 11) - d * 86_400_000).toISOString().slice(0, 10);
    rows.push({ local_date: date, nutrient_code: "energy_kcal", amount: 2100, coverage: 1 });
    rows.push({ local_date: date, nutrient_code: "protein", amount: 135, coverage: 1 });
  }
  return rows;
};

/**
 * The fixtures keep the `daily_totals` per-nutrient shape; the estimator reads `daily_energy`
 * (one row per date, the per-item selected energy), so only the energy row of each date reaches it.
 */
const energyRows = (rows: Record<string, unknown>[]) => rows
  .filter((row) => row.nutrient_code === undefined || row.nutrient_code === "energy_kcal")
  .map(({ nutrient_code: _code, ...row }) => row);

/** A chainable stand-in for a PostgREST query: filters, orders and limits like the real one. */
function estimatesBuilder(rows: Record<string, unknown>[]) {
  let q = [...rows];
  const builder = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    lte: () => builder,
    not: async () => ({ data: q, error: null }),
    order: (col: string, { ascending }: { ascending: boolean }) => {
      q = [...q].sort((a, b) => (ascending ? 1 : -1)
        * String(a[col]).localeCompare(String(b[col])));
      return builder;
    },
    limit: (n: number) => { q = q.slice(0, n); return builder; },
    maybeSingle: async () => ({ data: q[0] ?? null, error: null }),
  };
  return builder;
}

/**
 * A filtering stand-in for a PostgREST table read: `eq` / `gte` / `lte` / `not(col, "is", null)`
 * apply to the rows the way the real query does, so date-window reads (lib/server/date-chunks.ts)
 * see each row exactly once. Awaitable after any step.
 */
function tableBuilder(rows: Record<string, unknown>[]) {
  const filters: ((row: Record<string, unknown>) => boolean)[] = [];
  const result = () => ({ data: rows.filter((row) => filters.every((f) => f(row))), error: null });
  const builder = {
    select: () => builder,
    eq: (col: string, value: unknown) => {
      filters.push((row) => !(col in row) || row[col] === value); return builder; },
    gte: (col: string, value: string) => {
      filters.push((row) => String(row[col]) >= value); return builder; },
    lte: (col: string, value: string) => {
      filters.push((row) => String(row[col]) <= value); return builder; },
    not: (col: string) => { filters.push((row) => row[col] != null); return builder; },
    order: () => builder,
    then: (resolve: (value: ReturnType<typeof result>) => unknown) => resolve(result()),
  };
  return builder;
}

function adminWith(
  rows: Record<string, unknown>[],
  estimates: Record<string, unknown>[] = [],
  settings: Record<string, unknown> | null = null,
  markedDates: string[] = [],
) {
  const rpc = vi.fn().mockResolvedValue({ data: "e1", error: null });
  const from = vi.fn((table: string) => {
    if (table === "daily_energy") return tableBuilder(energyRows(rows));
    if (table === "user_settings") return estimatesBuilder(settings ? [settings] : []);
    // `markedDays` reads `plan_days`: a day is "marked" when its `day_complete_at` is set.
    if (table === "plan_days") {
      return tableBuilder(markedDates.map((d) => ({ local_date: d,
        day_complete_at: `${d}T21:00:00Z` })));
    }
    return estimatesBuilder(estimates);
  });
  return { admin: { from, rpc } as never, rpc };
}

/**
 * Unlike `adminWith`, this stand-in actually applies `gte`/`lte` to `local_date` the way the
 * real `daily_energy` query does — needed to exercise `runEstimate`'s HISTORY_DAYS window
 * truncation, which `adminWith` (and production `intakeDays`) always bound the fetch by.
 */
function windowedAdminWith(rows: Record<string, unknown>[]) {
  const rpc = vi.fn().mockResolvedValue({ data: "e1", error: null });
  const from = vi.fn((table: string) => {
    if (table === "user_settings") return estimatesBuilder([PROFILE]);
    if (table === "plan_days") return tableBuilder([]);
    if (table !== "daily_energy") return estimatesBuilder([]);
    return tableBuilder(energyRows(rows));
  });
  return { admin: { from, rpc } as never, rpc };
}

const weighIns = vi.fn(async () => {
  const out: { date: string; kg: number }[] = [];
  for (let d = 40; d >= 1; d -= 1) {
    out.push({ date: new Date(Date.UTC(2026, 8, 11) - d * 86_400_000).toISOString().slice(0, 10),
      kg: 57.5 - d * 0.004 });
  }
  return out;
});

const activityDays = vi.fn(async () => {
  const rows = [];
  for (let d = 35; d >= 1; d -= 1) {
    rows.push({
      local_date: new Date(Date.UTC(2026, 8, 11) - d * 86_400_000).toISOString().slice(0, 10),
      steps: d <= 7 ? 4_000 : 8_000,
      active_kcal: 300,
      sleep_minutes: null,
      body_mass_kg: null,
      resting_heart_rate: null,
      hrv_sdnn: null,
      readiness_score: null,
      sources: [],
      provenance: {},
    });
  }
  return rows;
});

describe("runEstimate", () => {
  it("turns daily_energy rows into IntakeDay and upserts through the RPC", async () => {
    const { admin, rpc } = adminWith(totalsRows(40), [], PROFILE);
    const result = await runEstimate(admin, "u1", "2026-09-11", {
      weighIns, activityDays, timeZone: "America/Denver",
    });
    expect(result.status).toBe("estimating");
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(rpc).toHaveBeenCalledWith("upsert_expenditure_estimate", expect.objectContaining({
      p_user_id: "u1",
      p_row: expect.objectContaining({ local_date: "2026-09-11", status: "estimating",
        engine_version: ENGINE_VERSION, learning_days_remaining: 0,
        phase: "adaptive", seed_source: "live_profile",
        activity_context: expect.objectContaining({ band: "lower", timeZone: "America/Denver",
          smoothing: "base", targetAdjustmentKcal: 0 }) }),
    }));
  });

  /* Design §6.4: the server's last-resort zone is the neutral `UTC`, not one person's own. The
     order is unchanged — the account's stored zone, then `HEALTH_TZ`, then the default — and only
     the default moved. */
  it("uses a valid user zone, then HEALTH_TZ, then the neutral default", async () => {
    const original = process.env.HEALTH_TZ;
    try {
      process.env.HEALTH_TZ = "America/Chicago";
      await expect(timeZoneFor(
        adminWith([], [], { time_zone: "America/Denver" }).admin, "u1",
      )).resolves.toBe("America/Denver");
      await expect(timeZoneFor(
        adminWith([], [], { time_zone: "Not/A_Time_Zone" }).admin, "u1",
      )).resolves.toBe("America/Chicago");

      process.env.HEALTH_TZ = "Also/Invalid";
      await expect(timeZoneFor(adminWith([], [], {}).admin, "u1")).resolves.toBe("UTC");
    } finally {
      if (original === undefined) delete process.env.HEALTH_TZ;
      else process.env.HEALTH_TZ = original;
    }
  });

  it("uses the health time-zone fallback order for activity context", async () => {
    const original = process.env.HEALTH_TZ;
    process.env.HEALTH_TZ = "America/Chicago";
    try {
      const { admin, rpc } = adminWith(totalsRows(40), [], PROFILE);
      await runEstimate(admin, "u1", "2026-09-11", {
        weighIns, activityDays, timeZone: "Not/A_Time_Zone",
      });
      expect(rpc).toHaveBeenCalledWith("upsert_expenditure_estimate", expect.objectContaining({
        p_row: expect.objectContaining({
          activity_context: expect.objectContaining({ timeZone: "America/Chicago" }),
        }),
      }));
    } finally {
      if (original === undefined) delete process.env.HEALTH_TZ;
      else process.env.HEALTH_TZ = original;
    }
  });

  it("refuses to run without a weigh-ins port rather than inventing weights", async () => {
    const { admin } = adminWith(totalsRows(40), [], PROFILE);
    await expect(runEstimate(admin, "u1", "2026-09-11")).rejects.toMatchObject({ status: 503 });
  });

  it("reads no intake from days without a selected-energy row", async () => {
    const { admin, rpc } = adminWith(totalsRows(40).filter((r) => r.nutrient_code !== "energy_kcal"), [], PROFILE);
    await runEstimate(admin, "u1", "2026-09-11", { weighIns });
    expect(rpc.mock.calls[0][1].p_row.status).toBe("burn_in");
  });

  it("marks a day qualified through plan_days.day_complete_at (step E6), independent of coverage",
    async () => {
      // One low-coverage day inside the window, but marked complete: it counts anyway (R3).
      const rows = totalsRows(40).map((r) =>
        r.local_date === new Date(Date.UTC(2026, 8, 11) - 5 * 86_400_000).toISOString().slice(0, 10)
          && r.nutrient_code === "energy_kcal" ? { ...r, coverage: 0.2 } : r);
      const markedDate = new Date(Date.UTC(2026, 8, 11) - 5 * 86_400_000).toISOString().slice(0, 10);
      const { admin, rpc } = adminWith(rows, [], PROFILE, [markedDate]);
      await runEstimate(admin, "u1", "2026-09-11", { weighIns });
      // The marked, low-coverage day still counted toward qualifiedDays — status stayed past
      // burn-in rather than treating it as a thin day.
      expect(rpc.mock.calls[0][1].p_row.status).not.toBe("burn_in");
    });

  it("holds the last valid estimate (R8) through a gap inside HELD_LOOKBACK_DAYS, never re-entering burn_in", async () => {
    // 60 qualified days ending 21 days before asOf, then nothing — a real gap (a UC flare, a long
    // break), short enough for the 28-day held lookback to still find the old estimate.
    const asOf = "2026-09-11";
    const rows: Record<string, unknown>[] = [];
    for (let d = 80; d >= 21; d -= 1) {
      const date = new Date(Date.UTC(2026, 8, 11) - d * 86_400_000).toISOString().slice(0, 10);
      rows.push({ local_date: date, nutrient_code: "energy_kcal", amount: 2100, coverage: 1 });
    }
    const gapWeighIns = async () => {
      const out: { date: string; kg: number }[] = [];
      for (let d = 80; d >= 21; d -= 1) {
        out.push({ date: new Date(Date.UTC(2026, 8, 11) - d * 86_400_000).toISOString().slice(0, 10),
          kg: 57.5 - d * 0.001 });
      }
      return out;
    };
    const { admin } = windowedAdminWith(rows);
    const result = await runEstimate(admin, "u1", asOf, { weighIns: gapWeighIns });
    expect(result.status).toBe("held");
    expect(result.tdeeKcal).not.toBeNull();
  });

  it("holds at the seed, not a stale number and not 'starting', once the gap outlasts HELD_LOOKBACK_DAYS", async () => {
    // exp-3 is stateless: 25 qualified days, all more than HELD_LOOKBACK_DAYS (28) before asOf,
    // with nothing logged since. R8 finds no recoverable point that far back, so it holds the seed;
    // an account that earned 14 counted days is never sent back to "starting" (GPT-6 Sol engine
    // review, 2026-10-04, finding 2).
    const asOf = "2026-09-11";
    const graduationRows: Record<string, unknown>[] = [];
    for (let d = 226; d >= 202; d -= 1) {
      const date = new Date(Date.UTC(2026, 8, 11) - d * 86_400_000).toISOString().slice(0, 10);
      graduationRows.push({ local_date: date, nutrient_code: "energy_kcal", amount: 2100, coverage: 1 });
    }
    const { admin } = windowedAdminWith(graduationRows);
    const result = await runEstimate(admin, "u1", asOf, { weighIns });
    expect(result.status).toBe("held");
    expect(result.phase).toBe("provisional");
    expect(result.tdeeKcal).toBe(1850);
    expect(result.proposalEligible).toBe(false);
    // Still graduated, not re-learning from zero: the fade (R2) counted the 25 old qualified days.
    expect(result.dataWeight).toBeGreaterThan(0);
  });
});

describe("per-account seeds (Devin, 2026-09-22)", () => {
  it("holds, with no number and a reason, when the account has no complete profile", async () => {
    const { admin, rpc } = adminWith(totalsRows(40), [], null);
    const result = await runEstimate(admin, "u1", "2026-09-11", { weighIns });
    expect(result).toMatchObject({ status: "held", tdeeKcal: null, confidence: 0,
      reason: HELD_WITHOUT_PROFILE_REASON });
    expect(rpc).toHaveBeenCalledWith("upsert_expenditure_estimate", expect.objectContaining({
      p_row: expect.objectContaining({ status: "held", tdee_kcal: null,
        reason: HELD_WITHOUT_PROFILE_REASON }),
    }));
  });

  it("seeds a fresh account's first estimate from its own formula TDEE, not a constant", async () => {
    // 40 days at 2,100 kcal with weigh-ins, seeded from the profile's own 1,848: the fade and the
    // observed intake move the estimate toward 2,100, nowhere near the retired 2,130 constant.
    const { admin } = adminWith(totalsRows(40), [], PROFILE);
    const result = await runEstimate(admin, "u1", "2026-09-11", { weighIns });
    expect(result.status).toBe("estimating");
    expect(result.tdeeKcal).toBeGreaterThanOrEqual(1660);
    expect(result.tdeeKcal).toBeLessThanOrEqual(2200);
  });

  it("hands the engine this account's own BMR and seed (Mifflin 1,320; × 1.40 = 1,848)", async () => {
    vi.mocked(estimateExpenditure).mockClear();
    const { admin } = adminWith(totalsRows(40), [], PROFILE);
    await runEstimate(admin, "u1", "2026-09-11", { weighIns });
    expect(estimateExpenditure).toHaveBeenCalledWith(
      expect.objectContaining({ bmrKcal: 1320, seedKcal: 1848 }));
  });

  it("holds an account that has a stored walk but an incomplete profile (ruling R3)", async () => {
    // Characterization: a grandfathered walk does not continue on borrowed numbers; it holds
    // with no number until the profile is complete, then reseeds from the formula.
    const { admin, rpc } = adminWith(totalsRows(40),
      [{ local_date: "2026-09-10", status: "estimating", tdee_kcal: 2050 }], null);
    const result = await runEstimate(admin, "u1", "2026-09-11", { weighIns });
    expect(result).toMatchObject({ status: "held", tdeeKcal: null,
      reason: HELD_WITHOUT_PROFILE_REASON, learningDaysRemaining: 21 });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("reads intake from the per-item selected energy, not the reported-only row (audit 19)",
    async () => {
      // daily_energy for a mixed day: 100 reported + 80 calculated = 180, both items counted.
      vi.mocked(estimateExpenditure).mockClear();
      const { admin } = adminWith([
        { local_date: "2026-09-10", amount: 180, items_with_value: 2, items_total: 2,
          coverage: 1, reported_items: 1, calculated_items: 1 },
      ], [], PROFILE);
      await runEstimate(admin, "u1", "2026-09-11", { weighIns });
      const input = vi.mocked(estimateExpenditure).mock.calls[0][0];
      expect(input.intake).toEqual([{ date: "2026-09-10", kcal: 180, energyCoverage: 1,
        userMarkedComplete: false }]);
    });

  it("never turns a day with no usable energy into a 0 kcal intake, even when marked", async () => {
    vi.mocked(estimateExpenditure).mockClear();
    const { admin } = adminWith([
      { local_date: "2026-09-09", amount: null, items_with_value: 0, items_total: 3,
        coverage: 0, reported_items: 0, calculated_items: 0 },
      { local_date: "2026-09-10", amount: 80, items_with_value: 1, items_total: 1,
        coverage: 1, reported_items: 0, calculated_items: 1 },
    ], [], PROFILE, ["2026-09-09"]);
    await runEstimate(admin, "u1", "2026-09-11", { weighIns });
    const input = vi.mocked(estimateExpenditure).mock.calls[0][0];
    expect(input.intake.map((day) => day.date)).toEqual(["2026-09-10"]);
    expect(input.intake[0].kcal).toBe(80);
  });

  it("carries no client-specific seed constant on the server path", () => {
    const source = readFileSync("lib/server/expenditure.ts", "utf8");
    expect(source).not.toMatch(/PRIOR_KCAL|BMR_KCAL|2130|1372/);
  });
});

describe("latestEstimate", () => {
  it("answers burn_in with nulls, not a 404, when no row exists", async () => {
    const { admin } = adminWith([], [], PROFILE);
    await expect(latestEstimate(admin, "u1")).resolves.toMatchObject({
      status: "burn_in", tdeeKcal: null, weightTrendKg: null, qualifiedDays: 0,
      weighInCount: 0, engineVersion: ENGINE_VERSION });
  });

  it("answers held-without-profile, not burn_in, when there is no row and no profile", async () => {
    const { admin } = adminWith([], [], null);
    await expect(latestEstimate(admin, "u1")).resolves.toMatchObject({
      status: "held", tdeeKcal: null, reason: HELD_WITHOUT_PROFILE_REASON,
      profileTdeeKcal: null, learningDaysRemaining: 21 });
  });

  it("maps a stored row onto the wire type, including nulls for columns an exp-2 row never wrote", async () => {
    const { admin } = adminWith([], [{ local_date: "2026-09-10", status: "estimating",
      tdee_kcal: "2210", weight_trend_kg: "57.4", intake_completeness: "0.93",
      qualified_days: 19, weigh_in_count: 18, confidence: "0.88", reason: null,
      engine_version: ENGINE_VERSION, learning_days_remaining: 0,
      activity_context: { version: "activity-1.0.0", asOf: "2026-09-10", timeZone: "UTC",
        currentStepsAvg: 8_000, currentDays: 7, baselineStepsAvg: 8_000, baselineDays: 28,
        deviationPct: 0, band: "usual", activeKcal7dAvg: null, activeKcalDays: 0,
        residualKcal: 80, smoothing: "base", targetAdjustmentKcal: 0 } }]);
    await expect(latestEstimate(admin, "u1")).resolves.toEqual({
      status: "estimating", localDate: "2026-09-10", tdeeKcal: 2210, weightTrendKg: 57.4,
      confidence: 0.88, intakeCompleteness: 0.93, qualifiedDays: 19, weighInCount: 18,
      reason: null, engineVersion: ENGINE_VERSION, profileTdeeKcal: null,
      learningDaysRemaining: 0,
      activityContext: { version: "activity-1.0.0", asOf: "2026-09-10", timeZone: "UTC",
        currentStepsAvg: 8_000, currentDays: 7, baselineStepsAvg: 8_000, baselineDays: 28,
        deviationPct: 0, band: "usual", activeKcal7dAvg: null, activeKcalDays: 0,
        residualKcal: 80, smoothing: "base", targetAdjustmentKcal: 0 },
      // exp-3 columns (phase, tdeeLowKcal, …) an exp-2 row never wrote: null, not missing.
      phase: null, tdeeLowKcal: null, tdeeHighKcal: null, dataWeight: null, seedSource: null,
      proposalEligible: null, reviewFlag: null, fluidCycleDays: null });
  });

  it("leaves learning days unknown for a pre-migration row", async () => {
    const { admin } = adminWith([], [{ local_date: "2026-09-10", status: "burn_in",
      tdee_kcal: null, weight_trend_kg: null, intake_completeness: "0.4",
      qualified_days: 8, weigh_in_count: 5, confidence: "0.3",
      reason: "Learning your numbers — 8 of 21 days", engine_version: "exp-1.0.0",
      learning_days_remaining: null, activity_context: null }]);

    const summary = await latestEstimate(admin, "u1");

    expect(summary.learningDaysRemaining).toBeUndefined();
    expect(summary).not.toHaveProperty("learningDaysRemaining");
  });

  it("returns the rounded profile-derived starting TDEE when the profile is complete", async () => {
    const { admin } = adminWith([], [], {
      sex: "female", birth_year: 1990, height_cm: 165, weight_kg: 60,
      body_fat_pct: null, activity_level: "moderate",
    });
    await expect(latestEstimate(admin, "u1")).resolves.toMatchObject({
      // Mifflin 1,290 × 1.40 (the conservative "moderate", ruling 2026-09-22) = 1,806.
      status: "burn_in", profileTdeeKcal: 1806, learningDaysRemaining: 21,
    });
  });
});
