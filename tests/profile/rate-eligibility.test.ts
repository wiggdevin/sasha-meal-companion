// Onboarding v2 question set §4 / gaps G1-G3 (owner decisions 2026-10-08): which stored answers
// hold the pace, and the derivation's own under-18 refusal.
import { describe, expect, it } from "vitest";
import {
  AdultOnlyError, SAFETY_CONDITION_TEXT, eligibilityFromSafetyAnswers, isMinorOn, paceAllowed,
  profileAffectsPace, safetyConditionEntries, standardProtein, targetEligibility,
} from "@/lib/profile/rate-eligibility";
import { deriveTargetRevision } from "@/lib/profile/derive";
import { isPregnant } from "@/lib/policy/pregnancy-tuna";
import { defaultSettings } from "@/lib/store";

describe("targetEligibility", () => {
  it("holds nothing for an account with no answers", () => {
    expect(targetEligibility({})).toEqual({ holds: [], minor: false });
    expect(targetEligibility({ conditions: ["IBS", "lactose intolerance"] }).holds).toEqual([]);
  });

  it.each([
    [["Pregnant"], ["pregnancy"]],
    [["32 weeks pregnant"], ["pregnancy"]],
    [["expecting"], ["pregnancy"]],
    [["Breastfeeding"], ["breastfeeding"]],
    [["breast-feeding my son"], ["breastfeeding"]],
    [["lactating"], ["breastfeeding"]],
    [["anorexia, in recovery"], ["eating_disorder"]],
    [["bulimia"], ["eating_disorder"]],
    [["ARFID"], ["eating_disorder"]],
    [["binge eating disorder"], ["eating_disorder"]],
    [["CKD stage 3"], ["kidney"]],
    [["renal failure"], ["kidney"]],
    [["on dialysis"], ["kidney"]],
    [["Diet set by my clinician"], ["clinician_diet"]],
    [["Pregnant", "kidney disease"], ["pregnancy", "kidney"]],
  ])("reads %j as %j", (conditions, holds) => {
    expect(targetEligibility({ conditions }).holds).toEqual(holds);
  });

  it("reads holds from stored dietary profiles and clinician-directed sources", () => {
    expect(targetEligibility({ profiles: [{ profileId: "pregnancy" }, { profileId: "lactation" },
      { profileId: "ckd_dialysis" }, { profileId: "eating_disorder_recovery" },
      { profileId: "halal", source: "clinician_directed_per_user" }] }).holds)
      .toEqual(["pregnancy", "breastfeeding", "eating_disorder", "kidney", "clinician_diet"]);
    expect(targetEligibility({ profiles: [{ profileId: "trying_to_conceive" }] }).holds).toEqual([]);
    expect(targetEligibility({ profiles: [{ profileId: "toString" }] }).holds).toEqual([]);
    expect(targetEligibility({ profiles: [{ profileId: "minor_under_18" }] }).minor).toBe(true);
  });

  it("knows which profile writes can move the pace", () => {
    expect(profileAffectsPace("pregnancy")).toBe(true);
    expect(profileAffectsPace("minor_under_18")).toBe(true);
    expect(profileAffectsPace("halal")).toBe(false);
    expect(profileAffectsPace("constructor")).toBe(false);
  });

  it("judges age by year arithmetic on the given date", () => {
    expect(isMinorOn(2009, "2026-10-08")).toBe(true);
    expect(isMinorOn(2008, "2026-01-01")).toBe(false);
    expect(isMinorOn(null, "2026-10-08")).toBe(false);
    expect(targetEligibility({ birthYear: 2010, onDate: "2026-10-08" }).minor).toBe(true);
  });
});

describe("the safety round's taps", () => {
  it("writes plain, removable condition entries; trying to conceive keeps every goal", () => {
    expect(safetyConditionEntries({ pregnancy: "pregnant", clinicianDiet: true,
      conditionText: "  kidney stones  " }))
      .toEqual(["Pregnant", "Diet set by my clinician", "kidney stones"]);
    expect(safetyConditionEntries({ pregnancy: "trying_to_conceive" })).toEqual([]);
    expect(paceAllowed(eligibilityFromSafetyAnswers({ pregnancy: "trying_to_conceive" }))).toBe(true);
    expect(paceAllowed(eligibilityFromSafetyAnswers({ pregnancy: "breastfeeding" }))).toBe(false);
    expect(standardProtein(eligibilityFromSafetyAnswers({ conditionText: "dialysis" }))).toBe(true);
  });

  it("arms the pregnancy tuna check with the tap's own word", () => {
    expect(isPregnant([SAFETY_CONDITION_TEXT.pregnant])).toBe(true);
    expect(isPregnant([SAFETY_CONDITION_TEXT.breastfeeding])).toBe(false);
  });
});

describe("deriveTargetRevision eligibility", () => {
  const settings = (over: Record<string, unknown> = {}) => ({ ...defaultSettings(),
    sex: "female" as const, birthYear: 1990, heightCm: 165, weightKg: 70,
    activityLevel: "sedentary" as const, goal: "lose_fat" as const, goalRateBpWeek: -50, ...over });
  const input = (over: Record<string, unknown> = {}, eligibility?: ReturnType<typeof targetEligibility>) => ({
    settings: settings(over), latestWeighInKg: null, today: "2026-10-08", trainingWeekdays: [],
    ...(eligibility ? { eligibility } : {}) });

  it("refuses an account under 18 even with no eligibility read", () => {
    expect(() => deriveTargetRevision(input({ birthYear: 2010 }))).toThrow(AdultOnlyError);
  });

  it("derives at maintenance for a held account and keeps the goal", () => {
    const free = deriveTargetRevision(input());
    const held = deriveTargetRevision(input({}, targetEligibility({ conditions: ["Pregnant"] })));
    expect(free.inputs.goalRateBpWeek).toBe(-50);
    expect(held.inputs.goalRateBpWeek).toBe(0);
    expect(held.inputs.goal).toBe("lose_fat");
    expect(held.training.kcal).toBeGreaterThan(free.training.kcal);
    expect(held.seed.initialTdeeKcal).toBe(free.seed.initialTdeeKcal);
  });
});
