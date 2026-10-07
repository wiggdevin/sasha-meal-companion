import { describe, expect, it } from "vitest";
import {
  barPct, barScale, clampGoal, clampUiGoal, CUP_ML, cupsToOz, goalColumnFor, goalFor,
  goalLabelFor, mergeCups, waterProgress, wholeCups,
} from "@/lib/water";

// 2026-10-04 audit (MINOR 8): wholeCups floored at one, so no water at all logged a cup.
describe("wholeCups", () => {
  it("is 0 for no water, a negative or a non-number", () => {
    for (const ml of [0, -240, Number.NaN, Number.POSITIVE_INFINITY]) expect(wholeCups(ml)).toBe(0);
  });

  it("rounds to the nearest cup, and under half a cup is 0", () => {
    expect(wholeCups(100)).toBe(0);
    expect(wholeCups(119)).toBe(0);
    expect(wholeCups(120)).toBe(1);
    expect(wholeCups(250)).toBe(1);
    expect(wholeCups(359)).toBe(1);
    expect(wholeCups(360)).toBe(2);
    expect(wholeCups(500)).toBe(2);
  });

  it("is never more than half a cup from the amount, and never negative (property)", () => {
    for (let ml = -500; ml <= 5000; ml += 7) {
      const cups = wholeCups(ml);
      expect(Number.isInteger(cups)).toBe(true);
      expect(cups).toBeGreaterThanOrEqual(0);
      if (ml > 0) expect(Math.abs(cups * CUP_ML - ml)).toBeLessThanOrEqual(CUP_ML / 2);
      if (ml > 0) expect(wholeCups(ml + CUP_ML)).toBe(cups + 1);
    }
  });
});

describe("water", () => {
  it("is 240 ml a cup and takes the larger count on a conflict", () => {
    expect(CUP_ML).toBe(240);
    expect([mergeCups(3, 5), mergeCups(5, 3)]).toEqual([5, 5]);
  });

  it("reports progress against the goal and caps the bar at 100 %", () => {
    expect(waterProgress(4, 8)).toEqual({ pct: 50, met: false });
    expect(waterProgress(9, 8)).toEqual({ pct: 100, met: true });
    expect(waterProgress(0, 0)).toEqual({ pct: 0, met: false });
  });

  it("clamps a goal into the column's check range", () => {
    expect([clampGoal(0), clampGoal(31), clampGoal(8.4)]).toEqual([1, 30, 8]);
  });

  it("reads a cup as 8 US ounces", () => {
    expect(cupsToOz(6)).toBe(48);
    expect(cupsToOz(0)).toBe(0);
  });

  it("keeps the stepper inside the UI range, which is narrower than the column", () => {
    expect([clampUiGoal(0), clampUiGoal(21), clampUiGoal(6.6)]).toEqual([1, 20, 7]);
  });
});

describe("the water goal per day type", () => {
  const goals = { water_goal_cups_training: 10, water_goal_cups_rest: 7 };

  it("picks the goal by day category, and both training day types share one", () => {
    expect(goalFor("training-10", goals)).toBe(10);
    expect(goalFor("training-7-fasted", goals)).toBe(10);
    expect(goalFor("rest", goals)).toBe(7);
  });

  it("names the column and the label for the viewed day", () => {
    expect(goalColumnFor("training-7-fasted")).toBe("water_goal_cups_training");
    expect(goalColumnFor("rest")).toBe("water_goal_cups_rest");
    expect(goalLabelFor("training-10")).toBe("Training-day goal");
    expect(goalLabelFor("rest")).toBe("Rest-day goal");
  });

  it("falls back to the legacy single column, then to 8", () => {
    expect(goalFor("rest", { water_goal_cups: 9 })).toBe(9);
    expect(goalFor("rest", {})).toBe(8);
    expect(goalFor("rest", undefined)).toBe(8);
  });
});

describe("the goal marker's bar", () => {
  it("scales to whichever is larger, so the goal always fits on the bar", () => {
    expect(barScale(6, 8)).toBe(8);
    expect(barScale(12, 8)).toBe(12);
    expect(barScale(0, 0)).toBe(1);
  });

  it("places the goal tick and the fill on that scale", () => {
    expect(barPct(8, barScale(6, 8))).toBe(100);
    expect(barPct(6, barScale(6, 8))).toBe(75);
    expect(barPct(12, barScale(12, 8))).toBe(100);
    expect(barPct(99, 0)).toBe(0);
  });
});
