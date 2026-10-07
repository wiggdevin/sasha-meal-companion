import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_BP, RATE_PRESETS_BP, confirmedRate, macroMinimumKcal, proteinBasisKg, rateTarget,
  settingsWithGoalRate, validateRate,
} from "./rate-goal";

// Step D ruling (GPT-5.6, 2026-09-22), docs/plans/2026-09-22-tdee-engine-plan.md §D.
describe("rate presets", () => {
  it("offers three loss and three gain rates, with −50 and +20 as defaults", () => {
    expect(RATE_PRESETS_BP.lose_fat).toEqual([-25, -50, -75]);
    expect(RATE_PRESETS_BP.gain_muscle).toEqual([10, 20, 25]);
    expect(RATE_PRESETS_BP.maintain).toEqual([0]);
    expect(RATE_PRESETS_BP.recomp).toEqual([0]);
    expect(DEFAULT_RATE_BP).toEqual({ lose_fat: -50, gain_muscle: 20, maintain: 0, recomp: 0 });
  });

  it("refuses a rate that is not a preset or points the wrong way for the goal", () => {
    expect(validateRate("maintain", 0)).toBe(true);
    expect(validateRate("recomp", -25)).toBe(false);
    expect(validateRate("maintain", 10)).toBe(false);
    expect(validateRate("lose_fat", 20)).toBe(false);
    expect(validateRate("lose_fat", -40)).toBe(false);
    expect(validateRate("gain_muscle", 25)).toBe(true);
  });
});

describe("rateTarget — the reference persona (TDEE 1,873, 72.6 kg)", () => {
  const base = { tdeeKcal: 1873, weightBasisKg: 72.6, kcalMin: 1430 };
  it.each([
    [-25, 1673, null], [-50, 1498, "rate_cap"], [-75, 1498, "rate_cap"],
    [10, 1953, null], [20, 2033, null], [25, 2060, "rate_cap"],
  ] as const)("%i bp/week → %i kcal", (goalRateBpWeek, kcal, bound) => {
    const out = rateTarget({ ...base, goalRateBpWeek, kcalMin: goalRateBpWeek > 0 ? 1374 : 1430 });
    expect(out.targetKcal).toBe(kcal);
    expect(out.bound).toBe(bound);
  });

  it("reports the effective rate when the cap binds (about −0.47 %/week)", () => {
    const out = rateTarget({ ...base, goalRateBpWeek: -75 });
    expect(out.effectiveRatePctWeek).toBeCloseTo(-0.469, 3);
  });

  it("is exactly TDEE at 0 bp", () => {
    expect(rateTarget({ ...base, goalRateBpWeek: 0 })).toMatchObject({ targetKcal: 1873, bound: null });
  });
});

describe("rateTarget — the minimum", () => {
  it("raises the target to the macro minimum and says so", () => {
    expect(rateTarget({ tdeeKcal: 1300, weightBasisKg: 40, goalRateBpWeek: -75, kcalMin: 1170 }))
      .toMatchObject({ targetKcal: 1170, bound: "kcal_min" });
  });

  it("uses an explicit account minimum when it is higher", () => {
    expect(rateTarget({ tdeeKcal: 1300, weightBasisKg: 40, goalRateBpWeek: -75,
      kcalMin: Math.max(1250, 1170) })).toMatchObject({ targetKcal: 1250, bound: "kcal_min" });
  });

  it("never lets the result break the TDEE cap or the minimum", () => {
    for (const tdeeKcal of [1100, 1500, 2200, 3400]) {
      for (const goalRateBpWeek of [-75, -50, -25, 0, 10, 20, 25]) {
        for (const weightBasisKg of [45, 70, 120]) {
          const kcalMin = 1200;
          const { targetKcal } = rateTarget({ tdeeKcal, weightBasisKg, goalRateBpWeek, kcalMin });
          expect(targetKcal).toBeGreaterThanOrEqual(kcalMin);
          if (targetKcal > kcalMin) {
            expect(targetKcal).toBeGreaterThanOrEqual(Math.round(0.8 * tdeeKcal) - 1);
            expect(targetKcal).toBeLessThanOrEqual(Math.round(1.1 * tdeeKcal) + 1);
          }
        }
      }
    }
  });
});

describe("macro minimum and protein basis", () => {
  it("counts protein, the 50 g fat floor and the 100 g carb floor", () => {
    expect(macroMinimumKcal({ proteinGMin: 145, fatGMin: 50, carbGMin: 100 })).toBe(1430);
    expect(macroMinimumKcal({ proteinGMin: 131, fatGMin: 50, carbGMin: 100 })).toBe(1374);
  });

  it("caps the protein basis at BMI 30 for the height", () => {
    expect(proteinBasisKg(100, 170)).toBeCloseTo(86.7, 1);
    expect(Math.round(proteinBasisKg(100, 170) * 2)).toBe(173);
    expect(proteinBasisKg(72.6, 170)).toBe(72.6);
  });
});

describe("confirmedRate — what a stored profile has actually confirmed", () => {
  it("keeps a preset that belongs to the goal", () => {
    expect(confirmedRate("lose_fat", -25)).toBe(-25);
    expect(confirmedRate("gain_muscle", 20)).toBe(20);
  });

  it("is 0 for maintain and recomp whatever is stored", () => {
    expect(confirmedRate("maintain", null)).toBe(0);
    expect(confirmedRate("recomp", -50)).toBe(0);
  });

  it("is null when a loss or gain goal has no confirmed rate, or no goal is set", () => {
    expect(confirmedRate("lose_fat", null)).toBeNull();
    expect(confirmedRate("lose_fat", 0)).toBeNull();
    expect(confirmedRate("lose_fat", 20)).toBeNull();
    expect(confirmedRate(null, -50)).toBeNull();
  });
});

describe("settingsWithGoalRate — a goal change resets the rate, nothing else touches it", () => {
  const before = { goal: "lose_fat" as const, goalRateBpWeek: -25 };

  it("gives a new goal its default rate unless the same write chose one", () => {
    expect(settingsWithGoalRate(before, { goal: "gain_muscle", goalRateBpWeek: -25 }))
      .toEqual({ goal: "gain_muscle", goalRateBpWeek: 20 });
    expect(settingsWithGoalRate(before, { goal: "gain_muscle", goalRateBpWeek: 10 }))
      .toEqual({ goal: "gain_muscle", goalRateBpWeek: 10 });
    expect(settingsWithGoalRate(before, { goal: "maintain", goalRateBpWeek: -25 }))
      .toEqual({ goal: "maintain", goalRateBpWeek: 0 });
  });

  it("leaves an unconfirmed rate alone when the goal does not change", () => {
    const legacy = { goal: "lose_fat" as const, goalRateBpWeek: null };
    expect(settingsWithGoalRate(legacy, { ...legacy })).toEqual(legacy);
    expect(settingsWithGoalRate(before, { ...before })).toEqual(before);
  });

  it("drops a rate that is not a preset for an unchanged goal, keeping the stored one", () => {
    expect(settingsWithGoalRate(before, { goal: "lose_fat", goalRateBpWeek: 20 }))
      .toEqual({ goal: "lose_fat", goalRateBpWeek: -25 });
    expect(settingsWithGoalRate({ goal: "lose_fat", goalRateBpWeek: null },
      { goal: "lose_fat", goalRateBpWeek: -40 })).toEqual({ goal: "lose_fat", goalRateBpWeek: null });
    expect(settingsWithGoalRate(before, { goal: "lose_fat", goalRateBpWeek: -75 }))
      .toEqual({ goal: "lose_fat", goalRateBpWeek: -75 });
  });

  it("clears the rate with the goal", () => {
    expect(settingsWithGoalRate(before, { goal: null, goalRateBpWeek: -25 }))
      .toEqual({ goal: null, goalRateBpWeek: null });
  });
});
