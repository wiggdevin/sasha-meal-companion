import { describe, expect, it } from "vitest";
import { lbToKg } from "@/lib/health/units";
import {
  autoGoalCups, autoGoalOz, hasManualGoal, resolveWaterGoal, waterGoalMode, waterWeightKg,
} from "@/lib/water-goal";

describe("the auto water goal from body weight", () => {
  it("gives about 0.6 oz per pound, rounded to the nearest cup", () => {
    expect(autoGoalOz(lbToKg(215), "rest")).toBe(128);
    expect(autoGoalOz(lbToKg(150), "rest")).toBe(88);
    expect(autoGoalOz(lbToKg(120), "rest")).toBe(72);
    expect(autoGoalCups(lbToKg(215), "rest")).toBe(16);
  });

  it("keeps 64 oz (8 cups) when the weight is unknown, on every day type", () => {
    for (const weight of [null, undefined, 0, -3, Number.NaN]) {
      expect(autoGoalOz(weight, "rest")).toBe(64);
      expect(autoGoalOz(weight, "training-10")).toBe(64);
    }
  });

  it("clamps to 64–160 oz", () => {
    expect(autoGoalOz(lbToKg(90), "rest")).toBe(64);
    expect(autoGoalOz(lbToKg(280), "rest")).toBe(160);
    expect(autoGoalOz(lbToKg(400), "rest")).toBe(160);
  });

  it("adds 16 oz on a training day, still capped at 160", () => {
    expect(autoGoalOz(lbToKg(215), "training-10")).toBe(144);
    expect(autoGoalOz(lbToKg(215), "training-7-fasted")).toBe(144);
    expect(autoGoalOz(lbToKg(260), "training-10")).toBe(160);
    expect(autoGoalOz(lbToKg(215))).toBe(128);
  });

  it("takes the first usable weight in the caller's order", () => {
    expect(waterWeightKg(null, undefined, 0, "", 80, 90)).toBe(80);
    expect(waterWeightKg("97.5")).toBe(97.5);
    expect(waterWeightKg(null, Number.NaN)).toBeNull();
  });
});

describe("a manual goal against the auto goal", () => {
  const weightKg = lbToKg(215);

  it("treats the columns' default of 8 as untouched, so every such account is auto", () => {
    expect(hasManualGoal({ water_goal_cups: 8, water_goal_cups_training: 8, water_goal_cups_rest: 8 })).toBe(false);
    expect(hasManualGoal(undefined)).toBe(false);
    expect(resolveWaterGoal({ dayType: "rest", stored: { water_goal_cups_rest: 8 }, prefs: {}, weightKg }))
      .toEqual({ cups: 16, mode: "auto", autoCups: 16, manualCups: 8 });
  });

  it("respects a goal set by hand", () => {
    const stored = { water_goal_cups: 8, water_goal_cups_training: 10, water_goal_cups_rest: 7 };
    expect(hasManualGoal(stored)).toBe(true);
    expect(resolveWaterGoal({ dayType: "rest", stored, prefs: {}, weightKg }))
      .toEqual({ cups: 7, mode: "manual", autoCups: 16, manualCups: 7 });
    expect(resolveWaterGoal({ dayType: "training-10", stored, prefs: {}, weightKg }).cups).toBe(10);
    // Release A's single goal counts as set by hand too.
    expect(waterGoalMode({}, { water_goal_cups: 11 })).toBe("manual");
  });

  it("lets an explicit choice win over the inference", () => {
    const stored = { water_goal_cups_training: 10, water_goal_cups_rest: 7 };
    expect(resolveWaterGoal({ dayType: "rest", stored, prefs: { goal: "auto" }, weightKg }).cups).toBe(16);
    expect(resolveWaterGoal({ dayType: "rest", stored: {}, prefs: { goal: "manual" }, weightKg }).cups).toBe(8);
  });
});
