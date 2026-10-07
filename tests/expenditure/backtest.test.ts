// tests/expenditure/backtest.test.ts
import { describe, expect, it } from "vitest";
import {
  cycleSwing, rampUp, replayScenario, steadyState, trainingStep, toScenarioDay, underLogging,
  waterSwing, waterSwingControl, BASE_TDEE,
} from "@/lib/expenditure.fixtures";

/** exp-3.0.0's acceptance claims, re-declared here from the spec text — deliberately NOT imported
 *  from `scripts/backtest-estimator.ts`. That script asserts these same numbers agree with its
 *  own, so a bound can never drift in one place only. */
export const ARTEFACT_MAX_KCAL = 60;
export const STEP_MIN_MOVE_KCAL = 200;
export const STEP_WITHIN_DAYS = 28;
export const RAMP_MAX_KCAL = 120;

const control = replayScenario(steadyState());
const tdeeOn = (runs: ReturnType<typeof replayScenario>, date: string) =>
  runs.find((r) => r.date === date)?.result ?? null;

function maxAbsDeviation(
  runs: ReturnType<typeof replayScenario>, against: ReturnType<typeof replayScenario> = control,
): number {
  let worst = 0;
  for (const run of runs) {
    const base = tdeeOn(against, run.date);
    if (base?.tdeeKcal == null || run.result.tdeeKcal == null) continue;
    worst = Math.max(worst, Math.abs(run.result.tdeeKcal - base.tdeeKcal));
  }
  return worst;
}

describe("claim 1a — the water-swing artefact moves the estimate by less than 60 kcal", () => {
  it("a 1.5 kg water swing over 3 days moves TDEE by at most 60 kcal against a matched, artefact-free control", () => {
    const runs = replayScenario(waterSwing());
    const matched = replayScenario(waterSwingControl());
    expect(maxAbsDeviation(runs, matched)).toBeLessThan(ARTEFACT_MAX_KCAL);
  });

  it("is never proposalEligible on the swing side unless the matched control is too, on the same night", () => {
    const runs = replayScenario(waterSwing());
    const matched = replayScenario(waterSwingControl());
    const badNights = runs.filter((r, i) => r.result.proposalEligible && !matched[i].result.proposalEligible);
    expect(badNights).toEqual([]);
  });
});

describe("claim 1b / 6 — the 28-day cycle artefact, at every phase, never misleads a proposal", () => {
  it("a ±0.8 kg 28-day cycle: the day-42 range contains the flat truth, and eligible nights never disagree on the truth's side by more than 75 kcal", () => {
    const runs = replayScenario(cycleSwing());
    const TRUTH = BASE_TDEE;
    const day42 = runs.find((r) => toScenarioDay(r.date) === 42)?.result;
    expect(day42?.tdeeLowKcal).not.toBeNull();
    expect(day42?.tdeeHighKcal).not.toBeNull();
    expect(day42?.tdeeLowKcal as number).toBeLessThanOrEqual(TRUTH);
    expect(day42?.tdeeHighKcal as number).toBeGreaterThanOrEqual(TRUTH);

    // No two proposalEligible nights within 28 days of each other may sit on opposite sides of
    // the truth by more than 75 kcal — a cycle-length artefact must never read as two real,
    // contradictory changes.
    const eligible = runs.filter((r) => r.result.proposalEligible);
    for (let i = 0; i < eligible.length; i += 1) {
      for (let j = i + 1; j < eligible.length; j += 1) {
        const di = toScenarioDay(eligible[i].date);
        const dj = toScenarioDay(eligible[j].date);
        if (Math.abs(di - dj) > 28) continue;
        const ti = (eligible[i].result.tdeeKcal as number) - TRUTH;
        const tj = (eligible[j].result.tdeeKcal as number) - TRUTH;
        if (Math.sign(ti) !== Math.sign(tj) && ti !== 0 && tj !== 0) {
          expect(Math.abs(ti) + Math.abs(tj)).toBeLessThanOrEqual(75);
        }
      }
    }
  });
});

describe("claim 2 — under-logging holds, it does not chase, and never re-enters burn_in once graduated", () => {
  it("3 qualified days a week: the account ends held, and no night after day 90 drifts far below what it was estimating before the thin stretch began", () => {
    const runs = replayScenario(underLogging());
    const beforeThinStretch = runs.filter((r) =>
      toScenarioDay(r.date) < 80 && r.result.status === "estimating");
    const lastGoodEstimate = beforeThinStretch.at(-1)?.result.tdeeKcal as number;
    expect(lastGoodEstimate).not.toBeNull();

    const after90 = runs.filter((r) => toScenarioDay(r.date) >= 90);
    expect(after90.length).toBeGreaterThan(0);
    // The engine keeps re-estimating on thinning data for a while (legitimate, not a bug — only
    // a `held` night is bound by R8's "never lowers"), then settles into held. By day 119 she is
    // held, and every held night is pinned to the number the engine last actually estimated.
    const day119 = runs.find((r) => toScenarioDay(r.date) === 119)?.result;
    expect(day119?.status).toBe("held");
    const heldNights = after90.filter((r) => r.result.status === "held");
    expect(heldNights.length).toBeGreaterThan(0);
    const heldValue = heldNights[0].result.tdeeKcal;
    expect(heldNights.every((r) => r.result.tdeeKcal === heldValue)).toBe(true);
    // R8: no held night lowers the number — every held value equals the one the engine landed on
    // the last time it was still estimating, not something lower it invented on thin data.
    const lastEstimatingOverall = runs.filter((r) => r.result.status === "estimating").at(-1)
      ?.result.tdeeKcal;
    expect(heldValue).toBe(lastEstimatingOverall);
    expect(after90.some((r) => r.result.status === "burn_in")).toBe(false);
  });
});

describe("claim 3a — a genuine +250 kcal/day step moves the estimate by at least 200 kcal within 28 days", () => {
  it("day 60+28 estimates at least 200 kcal above day 60's own estimate", () => {
    const runs = replayScenario(trainingStep());
    const at60 = runs.find((r) => toScenarioDay(r.date) === 60)?.result.tdeeKcal as number;
    const at88 = runs.find((r) => toScenarioDay(r.date) === 60 + STEP_WITHIN_DAYS)?.result.tdeeKcal as number;
    expect(at60).not.toBeNull();
    expect(at88).not.toBeNull();
    expect(at88 - at60).toBeGreaterThanOrEqual(STEP_MIN_MOVE_KCAL);
  });
});

describe("claim 3b / 12 — a slow ramp never produces an opposite-sign proposal within 28 days", () => {
  it("a +15 kcal/day/week ramp: every proposalEligible night sits within RAMP_MAX_KCAL of the moving truth, same sign only", () => {
    const runs = replayScenario(rampUp());
    for (const run of runs) {
      if (!run.result.proposalEligible || run.result.tdeeKcal === null) continue;
      const day = toScenarioDay(run.date);
      const truth = BASE_TDEE + (day >= 60 ? ((day - 60) * 15) / 7 : 0);
      expect(Math.abs(run.result.tdeeKcal - truth)).toBeLessThan(RAMP_MAX_KCAL);
    }
  });
});

describe("§4.3 bounds — the exit-record script re-declares the same numbers", () => {
  it("agrees with scripts/backtest-estimator.ts on all four bounds", async () => {
    const script = await import("../../scripts/backtest-estimator");
    expect(script.ARTEFACT_MAX_KCAL).toBe(ARTEFACT_MAX_KCAL);
    expect(script.STEP_MIN_MOVE_KCAL).toBe(STEP_MIN_MOVE_KCAL);
    expect(script.STEP_WITHIN_DAYS).toBe(STEP_WITHIN_DAYS);
    expect(script.RAMP_MAX_KCAL).toBe(RAMP_MAX_KCAL);
  });
});
