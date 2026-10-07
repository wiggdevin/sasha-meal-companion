// tests/proposals/build-proposal.test.ts
import { describe, expect, it } from "vitest";
import { buildProposal } from "@/lib/proposal";
import { ENGINE_VERSION, type ExpenditureResult } from "@/lib/expenditure";
import type { TargetProfile } from "@/lib/api-types";
import { HELD_WITHOUT_PROFILE_REASON, heldWithoutProfile } from "@/lib/server/expenditure";

const estimate = (over: Partial<ExpenditureResult> = {}): ExpenditureResult => ({
  status: "estimating", phase: "adaptive", tdeeKcal: 2200, tdeeLowKcal: 2050,
  tdeeHighKcal: 2350, dataWeight: 1, proposalEligible: true, reviewFlag: null, fluidCycleDays: null,
  observedShortKcal: 2210, observedLongKcal: 2200, weightTrendKg: 57.5, intakeAvgKcal: 2150,
  intakeCompleteness: 1, weighInCompleteness: 1, qualifiedDays: 21, weighInCount: 21,
  confidence: 1, reason: null, engineVersion: ENGINE_VERSION, learningDaysRemaining: 0, ...over,
});

const active = (over: Partial<TargetProfile> = {}): TargetProfile => ({
  id: "p1", user_id: "u1", effective_from: "2026-09-01", rev: 1,
  kcal_train: 2200, kcal_rest: 1750, authored_by: "user", mode: "grams",
  protein_g: 135, fat_g: 85, carb_g: 200, protein_pct: null, fat_pct: null, carb_pct: null,
  kcal_min: 1650, protein_g_min: 135, fat_g_min: 50, carb_g_min: 0,
  goal_rate_bp_week: 0, max_weekly_kcal_step: 150, notes: null,
  input_training_weekdays: [1, 3, 4, 5], ...over,
});

describe("buildProposal", () => {
  it("proposes nothing unless the estimate is estimating", () => {
    for (const status of ["burn_in", "held", "blocked"] as const) {
      expect(buildProposal({ estimate: estimate({ status }), active: active() }).kind).toBe("none");
    }
  });

  it("proposes nothing for the held-without-profile row, which carries no number", () => {
    const out = buildProposal({ estimate: heldWithoutProfile(), active: active() });
    expect(out).toEqual({ kind: "none", reason: HELD_WITHOUT_PROFILE_REASON });
  });

  it("proposes nothing when the engine says the estimate is not eligible (ruling R4)", () => {
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 2400, proposalEligible: false,
      reason: "Your last two weeks and last four weeks disagree" }), active: active() });
    expect(out).toEqual({ kind: "none", reason: "Your last two weeks and last four weeks disagree" });
  });

  it("proposes nothing for a move under 75 kcal/day on the weekly average (ruling R4)", () => {
    // Four days: (4 × 2200 + 3 × 1750) ÷ 7 = 2007; a TDEE of 2,050 is a 43 kcal move.
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 2050 }), active: active() });
    expect(out).toEqual({ kind: "none", reason: "Your current targets already fit your estimate" });
  });

  it("proposes nothing for a target with no stored training schedule", () => {
    for (const weekdays of [null, undefined]) {
      const out = buildProposal({ estimate: estimate(),
        active: active({ input_training_weekdays: weekdays }) });
      expect(out).toEqual({ kind: "none", reason: "No training schedule on the current target" });
    }
  });

  it("weights the weekly average by the account's own training days, not a fixed four", () => {
    // Four days: (4 × 2200 + 3 × 1750) ÷ 7 = 2007 ≈ TDEE 2000, so the plan barely moves.
    // Two days: (2 × 2200 + 5 × 1750) ÷ 7 = 1879, so the same TDEE raises both days.
    const four = buildProposal({ estimate: estimate({ tdeeKcal: 2000 }), active: active() });
    const two = buildProposal({ estimate: estimate({ tdeeKcal: 2000 }),
      active: active({ input_training_weekdays: [2, 6] }) });
    expect(four.kind).toBe("none");
    if (two.kind !== "proposal") throw new Error("expected a proposal");
    expect(two.proposed.deltaKcalTrain).toBeGreaterThan(100);
    expect(two.proposed.deltaKcalRest).toBeGreaterThan(80);
    const duplicates = buildProposal({ estimate: estimate({ tdeeKcal: 2000 }),
      active: active({ input_training_weekdays: [2, 2, 6, 9] }) });
    expect(duplicates).toEqual(two);
  });

  it("never moves protein from its authored value", () => {
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 2400 }), active: active() });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(out.proposed.proteinG).toBe(135);
  });

  it("keeps every calorie step inside max_weekly_kcal_step", () => {
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 3000 }), active: active() });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(Math.abs(out.proposed.deltaKcalTrain)).toBeLessThanOrEqual(150);
    expect(Math.abs(out.proposed.deltaKcalRest)).toBeLessThanOrEqual(150);
  });

  it("preserves the training / rest ratio", () => {
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 2250 }), active: active() });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(out.proposed.kcalTrain / out.proposed.kcalRest).toBeCloseTo(2200 / 1750, 2);
  });

  it("applies goal_rate_bp_week against the weight trend", () => {
    const flat = buildProposal({ estimate: estimate(), active: active() });
    const cutting = buildProposal({
      estimate: estimate(), active: active({ goal_rate_bp_week: -50 }) });
    if (flat.kind !== "proposal" || cutting.kind !== "proposal") throw new Error("expected proposals");
    expect(cutting.proposed.kcalTrain).toBeLessThan(flat.proposed.kcalTrain);
    // -50 bp/week of 57.5 kg = -0.2875 kg/week = -316 kcal/day
    expect(flat.proposed.kcalTrain - cutting.proposed.kcalTrain).toBeGreaterThan(100);
  });

  it("proposes nothing for a nonzero rate with no weight trend, instead of treating it as 0", () => {
    const out = buildProposal({ estimate: estimate({ weightTrendKg: null }),
      active: active({ goal_rate_bp_week: -50 }) });
    expect(out.kind).toBe("none");
    if (out.kind !== "none") throw new Error(out.kind);
    expect(out.reason).toMatch(/trend/i);
  });

  it("still proposes at 0 bp with no weight trend: maintenance needs no weight", () => {
    const out = buildProposal({ estimate: estimate({ weightTrendKg: null }), active: active() });
    expect(out.kind).toBe("proposal");
  });

  it("caps the rate at 20 % below the estimate before the weekly step applies", () => {
    // −75 bp of 57.5 kg is −474 kcal/day; the cap holds it at −440, so the desired average is
    // 1,760 and a profile already sitting there gets no move — so no proposal at all (R4).
    const out = buildProposal({ estimate: estimate(),
      active: active({ kcal_train: 1760, kcal_rest: 1760, protein_g: 135, fat_g: 60, carb_g: 170,
        goal_rate_bp_week: -75 }) });
    expect(out).toEqual({ kind: "none", reason: "Your current targets already fit your estimate" });
  });

  it("lets kcal_min win over the rate: a cutter on a legacy 1,650 floor is proposed up, by the step", () => {
    // TDEE 1,700, −75 bp of 57.5 kg wants 1,360; the row's 1,650 minimum wins, and the 150 kcal
    // step limits the move from 1,500 to 1,650 in one week.
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 1700 }),
      active: active({ kcal_train: 1500, kcal_rest: 1500, protein_g: 135, fat_g: 50, carb_g: 128,
        goal_rate_bp_week: -75, kcal_min: 1650 }) });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(out.proposed.kcalTrain).toBe(1650);
    expect(out.proposed.kcalRest).toBe(1650);
    expect(out.proposed.deltaKcalTrain).toBe(150);
  });

  it("never puts fat below 50 g or the authored value, and never kcal below kcal_min", () => {
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 1700 }), active: active({ fat_g: 40 }) });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(out.proposed.fatG).toBeGreaterThanOrEqual(50);
    expect(out.proposed.kcalRest).toBeGreaterThanOrEqual(1650);
  });

  it("blocks when a floor needs a rise above the step cap", () => {
    const out = buildProposal({
      estimate: estimate({ tdeeKcal: 1700 }),
      active: active({ kcal_train: 1700, kcal_rest: 1700, protein_g: 135, fat_g: 95,
        protein_g_min: 135, max_weekly_kcal_step: 20 }) });
    expect(out.kind).toBe("blocked");
    if (out.kind !== "blocked") throw new Error("expected blocked");
    expect(out.reason).toMatch(/floor/i);
  });

  it("resolves a percent profile through percentToGrams before proposing", () => {
    const out = buildProposal({ estimate: estimate(), active: active({
      mode: "percent", protein_g: null, fat_g: null, carb_g: null,
      protein_pct: 25, fat_pct: 35, carb_pct: 40 }) });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(out.proposed.proteinG).toBeGreaterThanOrEqual(135);
  });
});
