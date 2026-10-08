/**
 * Onboarding v2 question set: the beats' answers, the safety round as `SafetyAnswers`, and the
 * plan card's named defaults (QUESTION-SET-v2.md §1b, §4, §6).
 */
import { describe, expect, it } from "vitest";
import {
  activityFor, clock12, eligibilityFor, emptyPlanAnswers, isMinor, paceBeatNeeded, planCardNotes,
  safetyAnswersFrom, type PlanAnswers, type SafetyRound,
} from "./plan-answers";

const none: SafetyRound = { picks: [], pregnancy: null, medicines: [], conditionText: "" };

describe("plan answers", () => {
  it("infers activity from movement and workout days, and the person's chip wins", () => {
    expect(activityFor(null)).toBe("sedentary");
    const week = { trainingWeekdays: [1, 3, 5], noWorkouts: false, dailyMovement: "mostly_sitting" as const,
      activityOverride: null, skipped: false };
    expect(activityFor(week)).toBe("light");
    expect(activityFor({ ...week, activityOverride: "moderate" })).toBe("moderate");
    expect(activityFor({ ...week, noWorkouts: true })).toBe("sedentary");
  });

  it("maps the safety round onto the backend's SafetyAnswers, ignoring follow-ups of unpicked chips", () => {
    expect(safetyAnswersFrom(none)).toEqual({ pregnancy: null, clinicianDiet: false, conditionText: null });
    expect(safetyAnswersFrom({ ...none, picks: ["pregnancy"], pregnancy: "pregnant" }).pregnancy).toBe("pregnant");
    expect(safetyAnswersFrom({ ...none, picks: [], pregnancy: "pregnant" }).pregnancy).toBeNull();
    expect(safetyAnswersFrom({ ...none, picks: ["condition"], conditionText: "  kidney disease " }).conditionText)
      .toBe("kidney disease");
  });

  it("holds the pace for pregnancy, breastfeeding, kidney words and a clinician diet; not for trying to conceive", () => {
    const answers = (round: SafetyRound): PlanAnswers => ({ ...emptyPlanAnswers(), safety: round });
    expect(eligibilityFor(answers({ ...none, picks: ["pregnancy"], pregnancy: "pregnant" })).holds).toEqual(["pregnancy"]);
    expect(eligibilityFor(answers({ ...none, picks: ["pregnancy"], pregnancy: "breastfeeding" })).holds)
      .toEqual(["breastfeeding"]);
    expect(eligibilityFor(answers({ ...none, picks: ["pregnancy"], pregnancy: "trying_to_conceive" })).holds).toEqual([]);
    expect(eligibilityFor(answers({ ...none, picks: ["condition"], conditionText: "CKD stage 3" })).holds).toEqual(["kidney"]);
    expect(eligibilityFor(answers({ ...none, picks: ["clinician_diet"] })).holds).toEqual(["clinician_diet"]);
  });

  it("stops under 18 by birth year, and only then", () => {
    expect(isMinor(2010, "2026-10-08")).toBe(true);
    expect(isMinor(2008, "2026-10-08")).toBe(false);
    expect(isMinor(undefined, "2026-10-08")).toBe(false);
  });

  it("shows a pace beat only for chips or the minimum statement", () => {
    expect(paceBeatNeeded(null)).toBe(false);
    expect(paceBeatNeeded({ kind: "held", goal: "lose_fat" })).toBe(false);
    expect(paceBeatNeeded({ kind: "none", goal: "maintain" })).toBe(false);
    expect(paceBeatNeeded({ kind: "minimum", goal: "lose_fat", storeBp: -25, kcalMin: 1214, tdeeKcal: 1134 }))
      .toBe(true);
  });

  it("formats clock times in US 12-hour", () => {
    expect(clock12("08:00")).toBe("8:00 AM");
    expect(clock12("12:30")).toBe("12:30 PM");
    expect(clock12("18:30")).toBe("6:30 PM");
    expect(clock12("00:15")).toBe("12:15 AM");
  });

  it("names every skipped default on the plan card", () => {
    const notes = planCardNotes({ goal: "lose_fat", answers: emptyPlanAnswers(), pace: null,
      mealCount: 3, firstMealTime: "08:00" });
    expect(notes.map((note) => note.id)).toEqual(["training", "activity", "meals", "first_meal"]);
    expect(notes.find((note) => note.id === "activity")?.text).toMatch(/Activity: Sedentary/);
    expect(notes.find((note) => note.id === "meals")?.text).toBe("3 meals a day, set from your calories.");
    expect(notes.find((note) => note.id === "first_meal")?.text).toBe("First meal at 8:00 AM.");
  });

  it("names nothing the person chose, and adds the route notes", () => {
    const answers: PlanAnswers = {
      week: { trainingWeekdays: [1], noWorkouts: false, dailyMovement: "feet_some", activityOverride: null, skipped: false },
      safety: { ...none, picks: ["pregnancy", "condition"], pregnancy: "pregnant", conditionText: "kidney" },
      paceBp: null, goalWeightLb: null,
      day: { mealsPerDay: 4, firstMealTime: "07:30", inUs: true },
    };
    const ids = planCardNotes({ goal: "lose_fat", answers, pace: { kind: "held", goal: "lose_fat" },
      mealCount: 4, firstMealTime: "07:30" }).map((note) => note.id);
    expect(ids).toEqual(["held", "pregnancy", "kidney"]);
  });

  it("adds the insulin referral line on a loss goal", () => {
    const answers: PlanAnswers = { ...emptyPlanAnswers(),
      safety: { ...none, picks: ["medicine"], medicines: ["insulin"] } };
    const notes = planCardNotes({ goal: "lose_fat", answers, pace: null, mealCount: 3, firstMealTime: "08:00" });
    expect(notes.some((note) => note.id === "insulin")).toBe(true);
  });
});
