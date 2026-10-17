/**
 * TDEE step F (docs/plans/2026-09-22-tdee-engine-plan.md §F), adaptive cases no other test held:
 * a known gain rate, wrong priors at the 20 % and 30 % edges, identical observations across
 * accounts, and the 1.5 kg one-day spike. Noise-free series, so the numbers are exact and a change
 * to the fade, the window or the slope rule fails here.
 */
import { describe, expect, it } from "vitest";
import {
  estimateExpenditure, fromDayNumber, toDayNumber, type ExpenditureInput,
} from "@/lib/expenditure";
import {
  buildScenario, replayScenario, START_DATE, toScenarioDay, type Scenario,
} from "@/lib/expenditure.fixtures";

const BMR = 1338;

/** One night of the nightly job: everything logged before `day` (0-based from START_DATE). */
function night(scenario: Scenario, day: number, seedKcal: number, bmrKcal = BMR) {
  const end = toDayNumber(START_DATE) + day;
  return estimateExpenditure({ asOf: fromDayNumber(end), seedKcal, bmrKcal,
    weighIns: scenario.weighIns.filter((w) => toDayNumber(w.date) < end),
    intake: scenario.intake.filter((i) => toDayNumber(i.date) < end) });
}

describe("step F adaptive — known gain rate", () => {
  it("truth 2,000, intake 2,400 (about +0.36 kg/week) from a seed 200 low → 2,000 at day 42", () => {
    const gain = buildScenario({ label: "known-gain", seed: 9005, noiseKg: 0, noiseKcal: 0,
      tdee: () => 2000, intake: () => 2400 });
    const day28 = night(gain, 28, 1800);
    const day42 = night(gain, 42, 1800);
    // Day 28: half the fade (14 of 28 days past the start), so halfway from the seed.
    expect(day28).toMatchObject({ dataWeight: 0.5, tdeeKcal: 1900, observedLongKcal: 2000 });
    expect(day42).toMatchObject({ status: "estimating", phase: "adaptive", dataWeight: 1,
      tdeeKcal: 2000, observedLongKcal: 2000 });
    // The trend rises: 400 kcal/day over 7,700 kcal/kg.
    const trendGain = (day42.weightTrendKg as number) - (day28.weightTrendKg as number);
    expect(trendGain).toBeCloseTo((14 * 400) / 7700, 2);
  });

  it("with the fixtures' noise, gain and loss both land within 60 kcal of truth by day 50", () => {
    const gain = buildScenario({ label: "gain-noisy", seed: 9007, tdee: () => 2000,
      intake: () => 2400 });
    const loss = buildScenario({ label: "loss-noisy", seed: 9008, tdee: () => 2350,
      intake: () => 1800 });
    for (const day of [50, 60]) {
      expect(Math.abs((night(gain, day, 1800).tdeeKcal as number) - 2000), `gain ${day}`)
        .toBeLessThanOrEqual(60);
      expect(Math.abs((night(loss, day, 2100).tdeeKcal as number) - 2350), `loss ${day}`)
        .toBeLessThanOrEqual(60);
    }
  });
});

describe("step F adaptive — a 20–30 % wrong prior converges and is not anchored", () => {
  const flat = buildScenario({ label: "flat-2000", seed: 9006, noiseKg: 0, noiseKcal: 0,
    tdee: () => 2000, intake: () => 2000 });

  it.each([[1600, "20 % low"], [2400, "20 % high"], [1400, "30 % low"], [2600, "30 % high"]])(
    "seed %s (%s): seed at day 14, halfway at day 28, the truth exactly from day 42", (seed) => {
      expect(night(flat, 14, seed)).toMatchObject({ tdeeKcal: seed, dataWeight: 0 });
      expect(night(flat, 28, seed).tdeeKcal).toBe(seed + (2000 - seed) / 2);
      for (const day of [42, 50, 60, 90]) {
        expect(night(flat, day, seed), `day ${day}`).toMatchObject({ tdeeKcal: 2000,
          dataWeight: 1 });
      }
    });

  it("only the 30 %-low seed trips the far-from-seed review, which pauses proposals, not the number",
    () => {
      // |2,000 − 1,400| = 600 > 35 % × 1,400 = 490; |2,000 − 2,600| = 600 < 35 % × 2,600 = 910.
      const low = night(flat, 28, 1400);
      expect(low).toMatchObject({ reviewFlag: "far_from_seed", proposalEligible: false,
        tdeeKcal: 1700 });
      expect(night(flat, 28, 2600).reviewFlag).toBeNull();
      expect(night(flat, 28, 1600).reviewFlag).toBeNull();
    });
});

describe("step F adaptive — identical observations, identical estimates", () => {
  it("two accounts with the same days, seed and BMR get byte-identical results on every night",
    () => {
      const a = buildScenario({ label: "account-a", seed: 4242, tdee: () => 2200,
        intake: () => 2050 });
      // Account B: the same rows, copied, in reverse order, with a duplicate weigh-in per day.
      const b: Scenario = { ...a, label: "account-b",
        intake: [...a.intake].reverse().map((d) => ({ ...d })),
        weighIns: [...a.weighIns, ...a.weighIns].reverse().map((w) => ({ ...w })) };
      const runsA = replayScenario(a, { seedKcal: 2100, bmrKcal: 1450 });
      const runsB = replayScenario(b, { seedKcal: 2100, bmrKcal: 1450 });
      expect(runsB.map((r) => r.result)).toEqual(runsA.map((r) => r.result));
      expect(runsA.filter((r) => r.result.tdeeKcal !== null).length).toBeGreaterThan(90);
    });

  it("the result depends only on its own input: a call for another account in between changes nothing",
    () => {
      const mine = buildScenario({ label: "mine", seed: 77, tdee: () => 2000, intake: () => 2000 });
      const other = buildScenario({ label: "other", seed: 78, tdee: () => 2600,
        intake: () => 1900 });
      const input = (s: Scenario, seedKcal: number): ExpenditureInput => ({ asOf: s.asOf,
        weighIns: s.weighIns, intake: s.intake, seedKcal, bmrKcal: 1400 });
      const before = estimateExpenditure(input(mine, 1800));
      const between = estimateExpenditure(input(other, 2900));
      const after = estimateExpenditure(input(mine, 1800));
      expect(after).toEqual(before);
      expect(between.tdeeKcal).not.toBe(before.tdeeKcal);
    });
});

describe("step F noise — a one-day 1.5 kg spike (salt, a big meal) makes no proposal", () => {
  it("moves no night by more than one 10 kcal step and changes no night's eligibility", () => {
    const spike = buildScenario({ label: "spike", seed: 1002, noiseKg: 0, tdee: () => 2130,
      intake: () => 2130, artefactKg: (d) => (d === 70 ? 1.5 : 0) });
    const control = buildScenario({ label: "spike-control", seed: 1002, noiseKg: 0,
      tdee: () => 2130, intake: () => 2130 });
    const runs = replayScenario(spike);
    const base = replayScenario(control);
    for (let i = 0; i < runs.length; i += 1) {
      const a = runs[i].result;
      const b = base[i].result;
      expect(a.proposalEligible, runs[i].date).toBe(b.proposalEligible);
      if (a.tdeeKcal === null || b.tdeeKcal === null) {
        expect(a.tdeeKcal).toBe(b.tdeeKcal);
        continue;
      }
      expect(Math.abs(a.tdeeKcal - b.tdeeKcal), runs[i].date).toBeLessThanOrEqual(10);
    }
    // The nights right after the spike are real, eligible nights: the case is exercised.
    expect(runs.filter((r) => toScenarioDay(r.date) > 70 && toScenarioDay(r.date) <= 84
      && r.result.proposalEligible).length).toBeGreaterThan(0);
  });
});
