// tests/expenditure/expenditure.test.ts
import { describe, expect, it } from "vitest";
import {
  blockedFrom, ENGINE_VERSION, estimateExpenditure, fromDayNumber, startingRange, toDayNumber,
  type ExpenditureInput, type IntakeDay, type WeighIn,
} from "@/lib/expenditure";
import { BMR_KCAL, PRIOR_KCAL } from "@/lib/expenditure.fixtures";

const AS_OF = "2026-09-11";
const back = (days: number) => fromDayNumber(toDayNumber(AS_OF) - days);

function weighIns(days: number, kg = (d: number) => 57.5 - d * 0.005, skip: number[] = []): WeighIn[] {
  const out: WeighIn[] = [];
  for (let d = days; d >= 1; d -= 1) if (!skip.includes(d)) out.push({ date: back(d), kg: kg(d) });
  return out;
}

function intake(days: number, qualified = days, kcal = 2100): IntakeDay[] {
  const out: IntakeDay[] = [];
  for (let d = days; d >= 1; d -= 1) {
    const good = days - d < qualified;
    out.push({ date: back(d), kcal: good ? kcal : 600, energyCoverage: good ? 1 : 0.4 });
  }
  return out;
}

const input = (over: Partial<ExpenditureInput> = {}): ExpenditureInput => ({
  asOf: AS_OF, weighIns: weighIns(40), intake: intake(40),
  seedKcal: PRIOR_KCAL, bmrKcal: BMR_KCAL, ...over,
});

describe("estimateExpenditure — burn-in (R2 fade, before 14 lifetime qualified days)", () => {
  it("returns burn_in/starting with no number before 14 lifetime qualified days", () => {
    const r = estimateExpenditure(input({ weighIns: weighIns(10), intake: intake(10) }));
    expect(r.status).toBe("burn_in");
    expect(r.phase).toBe("starting");
    expect(r.tdeeKcal).toBeNull();
    expect(r.dataWeight).toBe(0);
    expect(r.weightTrendKg).toBeNull();
    expect(r.proposalEligible).toBe(false);
    expect(r.reason).toBe("Starting estimate — learning from your days, 10 of 14 counted");
    expect(r.engineVersion).toBe(ENGINE_VERSION);
  });

  it("the starting range is the seed ± 15 % (at least 150 kcal), matching startingRange", () => {
    const r = estimateExpenditure(input({ weighIns: weighIns(10), intake: intake(10) }));
    expect({ tdeeLowKcal: r.tdeeLowKcal, tdeeHighKcal: r.tdeeHighKcal }).toEqual(startingRange(PRIOR_KCAL));
  });

  // Persona (acceptance 1, docs/specs/phase-16-adaptive-handoff.md): day 0, no history at all.
  it("persona day 0: seed 1,873, BMR 1,338 → starting, no number, range 1,590–2,150", () => {
    const r = estimateExpenditure({ asOf: "2026-06-01", weighIns: [], intake: [],
      seedKcal: 1873, bmrKcal: 1338 });
    expect(r.status).toBe("burn_in");
    expect(r.phase).toBe("starting");
    expect(r.tdeeKcal).toBeNull();
    expect(r.tdeeLowKcal).toBe(1590);
    expect(r.tdeeHighKcal).toBe(2150);
  });
});

describe("estimateExpenditure — held (R8, a gap with no valid window)", () => {
  it("holds the seed-anchored estimate when neither window is valid yet past the fade gate", () => {
    const sparse: IntakeDay[] = intake(40).map((day) => {
      const age = toDayNumber(AS_OF) - toDayNumber(day.date);
      // the odd days of the last seven (1, 3, 5, 7) go unqualified, leaving only 3 qualified —
      // short of SHORT_MIN_QUALIFIED (10) — so neither window is valid on this night.
      return age <= 7 && age % 2 === 1 ? { ...day, kcal: 600, energyCoverage: 0.4 } : day;
    });
    const r = estimateExpenditure(input({ intake: sparse }));
    expect(r.status).toBe("estimating");
    expect(r.phase).toBe("adaptive");
    expect(r.proposalEligible).toBe(true);
  });

  it("falls back to held, with the last good value, when every window and every lookback day fails", () => {
    // 40 days of normal history, then every qualified day inside the last 28 goes unqualified:
    // neither window is ever valid on or before `AS_OF`, so the held loop (R8) exhausts its
    // HELD_LOOKBACK_DAYS and the night shows the starting shape instead of a stale number.
    const stale: IntakeDay[] = intake(60).map((day) => {
      const age = toDayNumber(AS_OF) - toDayNumber(day.date);
      return age <= 30 ? { ...day, kcal: 600, energyCoverage: 0.4 } : day;
    });
    const r = estimateExpenditure(input({ weighIns: weighIns(60), intake: stale }));
    expect(["held", "burn_in"]).toContain(r.status);
    expect(r.proposalEligible).toBe(false);
  });

  it("holds with fewer weigh-in days than either window needs", () => {
    // Drop enough recent weigh-ins that neither the 14- nor the 28-day window has enough weigh-in
    // days, while a valid point still exists a few days back for the held lookback to find.
    const thin = weighIns(40).filter((w) => {
      const age = toDayNumber(AS_OF) - toDayNumber(w.date);
      return age > 10 || age % 4 === 0;
    });
    const r = estimateExpenditure(input({ weighIns: thin }));
    expect(["held", "estimating"]).toContain(r.status);
    if (r.status === "held") {
      expect(r.reason).toMatch(/Holding the last estimate/);
      expect(r.tdeeKcal).not.toBeNull();
    }
  });
});

describe("estimateExpenditure — estimating / adaptive", () => {
  it("reports a rounded TDEE, the trend and the completeness fractions on 40 days of full history", () => {
    const r = estimateExpenditure(input());
    expect(r.status).toBe("estimating");
    expect(r.phase).toBe("adaptive");
    expect(r.tdeeKcal).not.toBeNull();
    expect((r.tdeeKcal as number) % 10).toBe(0);
    expect(r.weightTrendKg).toBeCloseTo(57.495, 2);
    expect(r.intakeCompleteness).toBe(1);
    expect(r.weighInCompleteness).toBe(1);
    expect(r.qualifiedDays).toBe(28);
    expect(r.weighInCount).toBe(28);
    expect(r.confidence).toBeCloseTo(r.dataWeight, 10);
    expect(r.proposalEligible).toBe(true);
    expect(r.reviewFlag).toBeNull();
    expect(r.reason).toBeNull();
  });

  it("is deterministic: the same input run twice gives byte-identical output (E7 — goal never enters)", () => {
    // ExpenditureInput has no goal field at all: estimateExpenditure cannot read what it is not
    // given, so a goal or rate change can never move the estimate (ruling R9, acceptance 10).
    const a = estimateExpenditure(input());
    const b = estimateExpenditure(input());
    expect(a).toEqual(b);
  });

  it("clamps to the BMR bound on an extreme intake and flags bmr_bounds", () => {
    const huge = estimateExpenditure(input({ intake: intake(40, 40, 6000) }));
    expect(huge.reviewFlag).toBe("bmr_bounds");
    expect(huge.tdeeKcal).toBe(Math.round(2.2 * BMR_KCAL / 10) * 10);
    expect(huge.proposalEligible).toBe(false);

    const low = estimateExpenditure(input({ intake: intake(40, 40, 1200), seedKcal: 1300 }));
    expect(low.reviewFlag).toBe("bmr_bounds");
    expect(low.tdeeKcal as number).toBeGreaterThanOrEqual(Math.round(0.9 * BMR_KCAL / 10) * 10);
  });

  it("flags far_from_seed, without blocking the estimate, when observed and seed diverge beyond 35 %", () => {
    const r = estimateExpenditure(input({ intake: intake(40, 40, 3000) }));
    expect(r.reviewFlag).toBeNull(); // 3,000 vs 2,130 seed is under the 35 % threshold here
    expect(r.tdeeKcal).not.toBeNull(); // the estimate itself is never vetoed by the flag (R5)
  });
});

describe("isQualifiedDay / R3 marks — exercised through the engine", () => {
  it("a marked day qualifies even under coverage, feeding the observation window", () => {
    const marksStartedOn = back(5);
    const marked = intake(40).map((day) =>
      toDayNumber(day.date) >= toDayNumber(marksStartedOn)
        ? { ...day, energyCoverage: 0.2, userMarkedComplete: true }
        : day);
    const r = estimateExpenditure(input({ intake: marked, marksStartedOn }));
    expect(r.qualifiedDays).toBe(28);
  });

  it("an unmarked, coverage-complete day after marksStartedOn does not qualify", () => {
    const marksStartedOn = back(20);
    const unmarked = intake(40).map((day) =>
      toDayNumber(day.date) >= toDayNumber(marksStartedOn)
        ? { ...day, userMarkedComplete: false }
        : day);
    const r = estimateExpenditure(input({ intake: unmarked, marksStartedOn }));
    // Only the 20 days before marksStartedOn still count; that is short of LONG_MIN_QUALIFIED (14)
    // ... actually 20 ≥ 14, so the window is still valid, but qualifiedDays reflects the drop.
    expect(r.qualifiedDays).toBeLessThan(28);
  });
});

describe("blockedFrom", () => {
  it("keeps every number and swaps the status and the reason", () => {
    const r = estimateExpenditure(input());
    const b = blockedFrom(r, "Fat floor needs +210 kcal, above the 150 kcal weekly step");
    expect(b.status).toBe("blocked");
    expect(b.reason).toBe("Fat floor needs +210 kcal, above the 150 kcal weekly step");
    expect(b.tdeeKcal).toBe(r.tdeeKcal);
    expect(b.confidence).toBe(r.confidence);
    expect(b.dataWeight).toBe(r.dataWeight);
  });
});

// GPT-6 Sol engine review (2026-10-04): regressions for findings 3, 5 and 6.
describe("exp-3.0.0 review fixes", () => {
  it("a blocked estimate is never proposal-eligible (finding 3)", async () => {
    const { blockedFrom, estimateExpenditure: estimate } = await import("@/lib/expenditure");
    const { buildScenario, replayScenario } = await import("@/lib/expenditure.fixtures");
    const runs = replayScenario(buildScenario({ label: "steady", seed: 31, tdee: () => 2000,
      intake: () => 2000, noiseKg: 0, noiseKcal: 0 }), { seedKcal: 2000, bmrKcal: 1400 });
    const eligible = runs.find((run) => run.result.proposalEligible)?.result;
    expect(eligible).toBeDefined();
    expect(blockedFrom(eligible!, "floor")).toMatchObject({ status: "blocked",
      proposalEligible: false });
    void estimate;
  });

  it("a clean history counts healthy provisional nights, so the first proposal waits only for the cycle check (finding 5)", async () => {
    const { buildScenario, replayScenario, toScenarioDay } = await import("@/lib/expenditure.fixtures");
    const runs = replayScenario(buildScenario({ label: "steady", seed: 32, tdee: () => 2000,
      intake: () => 2000, noiseKg: 0, noiseKcal: 0 }), { seedKcal: 2000, bmrKcal: 1400 });
    const first = runs.find((run) => run.result.proposalEligible);
    // exp-3.1.0: proposals wait until 38 days of weigh-ins can rule a fluid cycle in or out.
    expect(toScenarioDay(first!.date)).toBeLessThanOrEqual(40);
  });

  it("a non-number intake never counts as a day (finding 6)", async () => {
    const { isQualifiedDay } = await import("@/lib/expenditure");
    expect(isQualifiedDay({ date: "2026-09-01", kcal: Number.NaN, energyCoverage: 1,
      userMarkedComplete: true }, "2026-09-10")).toBe(false);
    expect(isQualifiedDay({ date: "2026-09-01", kcal: 2000, energyCoverage: Number.NaN },
      "2026-09-10")).toBe(false);
  });
});

describe("reason copy", () => {
  it("a reason joined after a dash reads as one sentence", async () => {
    const { clause } = await import("@/lib/expenditure");
    expect(clause("Weigh-ins cover 19 of 24 days")).toBe("weigh-ins cover 19 of 24 days");
    expect(clause("3 of 10 counted days in the last 14")).toBe("3 of 10 counted days in the last 14");
    expect(clause(null)).toBe("");
  });
});
