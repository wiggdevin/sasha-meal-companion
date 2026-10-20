import { describe, expect, it } from "vitest";
import { activeIntake, insights, proteinTraining, sleepIntake, weekendIntake } from "@/lib/trends/insights";
import { trendDays } from "./fixtures";

const END = "2026-10-18"; // a Sunday; "today" in these fixtures is the last day, left out of intake as partial

describe("insights", () => {
  it("says calories rise after shorter sleep, with the day count in the line", () => {
    const days = trendDays(END, 12, (i) => ({ sleepMin: i % 2 ? 360 : 480, kcal: i % 2 ? 2400 : 2000 }));
    const found = sleepIntake(days);
    expect(found?.text).toBe("After shorter sleep you ate about 20% more (12 days).");
  });

  it("stays silent with too few days, or a difference too small to say", () => {
    expect(sleepIntake(trendDays(END, 5, (i) => ({ sleepMin: i % 2 ? 360 : 480, kcal: i % 2 ? 2400 : 2000 })))).toBeNull();
    expect(sleepIntake(trendDays(END, 12, (i) => ({ sleepMin: i % 2 ? 360 : 480, kcal: i % 2 ? 2050 : 2000 })))).toBeNull();
  });

  it("never counts a partial day", () => {
    const days = trendDays(END, 12, (i) => ({ sleepMin: i % 2 ? 360 : 480, kcal: i % 2 ? 2400 : 2000,
      intakePartial: i % 2 === 1 }));
    expect(sleepIntake(days)).toBeNull();
  });

  it("compares protein on training and rest days against the revision's target", () => {
    const days = trendDays(END, 10, (i) => ({ dayType: i < 5 ? "training-10" : "rest", proteinTarget: 140,
      protein: i < 5 ? 150 : 100 }));
    expect(proteinTraining(days)?.text)
      .toBe("Protein reached its target on 5 of 5 training days and 0 of 5 rest days.");
    expect(proteinTraining(trendDays(END, 10, (i) => ({ dayType: i < 5 ? "training-10" : "rest", protein: 150 })))).toBeNull();
  });

  it("compares weekends with weekdays", () => {
    const days = trendDays(END, 14, (_i, date) => {
      const weekend = ["2026-10-10", "2026-10-11", "2026-10-17", "2026-10-18"].includes(date);
      return { kcal: weekend ? 2600 : 2000 };
    });
    expect(weekendIntake(days)?.text).toBe("On weekends you ate about 30% more than on weekdays (14 days).");
  });

  it("returns at most three, the clearest first, and never a model call or a medical word", () => {
    const days = trendDays(END, 21, (i) => ({ sleepMin: i % 2 ? 360 : 480, kcal: i % 2 ? 2600 : 2000,
      activeKcal: i % 2 ? 600 : 200, dayType: i % 3 ? "rest" : "training-10", proteinTarget: 140,
      protein: i % 3 ? 100 : 150 }));
    const found = insights(days);
    expect(found.length).toBeLessThanOrEqual(3);
    expect(found.map((i) => i.strength)).toEqual([...found.map((i) => i.strength)].sort((a, b) => b - a));
    expect(activeIntake(days)).not.toBeNull();
    for (const i of found) expect(i.text).not.toMatch(/should|risk|health|disease|diet/i);
  });
});
