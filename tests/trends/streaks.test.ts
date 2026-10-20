import { describe, expect, it } from "vitest";
import { streak, streakFigure, streaks } from "@/lib/trends/streaks";
import { trendDays } from "./fixtures";

const TODAY = "2026-10-19";

describe("streaks", () => {
  it("counts fully logged days back from yesterday while today is still open", () => {
    const days = trendDays(TODAY, 10, (i) => ({ fullyLogged: i >= 6 && i < 9 }));
    expect(streak("fully_logged", days)).toEqual({ kind: "fully_logged", days: 3, capped: false });
  });

  it("counts today once it qualifies", () => {
    const days = trendDays(TODAY, 5, (i) => ({ fullyLogged: i >= 2 }));
    expect(streak("fully_logged", days).days).toBe(3);
  });

  it("ends on a missing or partial day rather than guessing (days on plan)", () => {
    const days = trendDays(TODAY, 6, (i) => ({ kcalTarget: 2000,
      kcal: i === 2 ? null : 2050, intakePartial: i === 5 }));
    expect(streak("on_plan", days).days).toBe(2);
    const over = trendDays(TODAY, 4, () => ({ kcalTarget: 2000, kcal: 2400 }));
    expect(streak("on_plan", over).days).toBe(0);
  });

  it("marks a streak that reaches the start of the window as capped (water goal met)", () => {
    const days = trendDays(TODAY, 7, () => ({ cups: 9, waterGoal: 8 }));
    const run = streak("water", days);
    expect(run).toEqual({ kind: "water", days: 7, capped: true });
    expect(streakFigure(run)).toBe("7+");
  });

  it("leaves out days on plan with no target revision and water with no goal", () => {
    const days = trendDays(TODAY, 7, () => ({ fullyLogged: true }));
    expect(streaks(days).map((s) => s.kind)).toEqual(["fully_logged"]);
  });
});
