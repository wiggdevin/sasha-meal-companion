// Onboarding v2 question set §2b–§2d (gap G5): the pace chips in lb a week after the 20 %
// below-burn cap and the minimum. The persona rows are §2b's own table, computed with the engine.
import { describe, expect, it } from "vitest";
import {
  chipForRequestedPace, impliedDate, paceChoices, roundLbHalfUp, type PaceChoices,
} from "@/lib/profile/pace";
import { inferActivity } from "@/lib/profile/activity-infer";
import { targetEligibility } from "@/lib/profile/rate-eligibility";
import type { ActivityLevel, Goal } from "@/lib/types";

const TODAY = new Date("2026-10-08T12:00:00.000Z");
const person = (sex: "male" | "female", age: number, ft: number, inch: number, lb: number,
  activityLevel: ActivityLevel, goal: Goal) => ({
  sex, birthYear: 2026 - age, heightCm: (ft * 12 + inch) * 2.54, weightKg: lb / 2.2046226218,
  bodyFatPct: null, activityLevel, goal });
const pace = (p: ReturnType<typeof person>, eligibility?: Parameters<typeof paceChoices>[0]["eligibility"]) =>
  paceChoices({ profile: p, today: TODAY, trainingDays: 0, eligibility });
const chips = (result: PaceChoices) => result.kind === "choices"
  ? result.choices.map((c) => [c.label, c.targetKcal, c.underTenth ? "<0.1" : c.lbPerWeek, c.bound])
  : result.kind;

describe("paceChoices — §2b personas", () => {
  it("woman 35, 5'4\", 150 lb, sitting: the minimum makes Faster the same as Steady", () => {
    const result = pace(person("female", 35, 5, 4, 150, "sedentary", "lose_fat"));
    expect(result).toMatchObject({ tdeeKcal: 1632, kcalMin: 1394, preselectedBp: -50 });
    expect(chips(result)).toEqual([["Gentle", 1445, 0.4, null], ["Steady", 1394, 0.5, "kcal_min"]]);
  });

  it("man 40, 5'10\", 200 lb, light: the 20 % cap binds on Steady", () => {
    const result = pace(person("male", 40, 5, 10, 200, "light", "lose_fat"));
    expect(result).toMatchObject({ tdeeKcal: 2370, kcalMin: 1574 });
    expect(chips(result)).toEqual([["Gentle", 2121, 0.5, null], ["Steady", 1896, 0.9, "rate_cap"]]);
  });

  it("woman 45, 5'6\", 250 lb, sitting: nobody gets 1.5 or 2 lb a week", () => {
    const result = pace(person("female", 45, 5, 6, 250, "sedentary", "lose_fat"));
    expect(result).toMatchObject({ tdeeKcal: 2155, kcalMin: 1526 });
    expect(chips(result)).toEqual([["Gentle", 1843, 0.6, null], ["Steady", 1724, 0.9, "rate_cap"]]);
  });

  it("woman 60, 5'2\", 130 lb: one chip, under 0.1 lb, pre-selected though it is not Steady", () => {
    const result = pace(person("female", 60, 5, 2, 130, "sedentary", "lose_fat"));
    expect(result).toMatchObject({ tdeeKcal: 1336, kcalMin: 1322, preselectedBp: -25 });
    expect(chips(result)).toEqual([["Gentle", 1322, "<0.1", "kcal_min"]]);
  });

  it("woman 60, 5'0\", 100 lb: a loss pace would gain, so no chips (direction guard)", () => {
    expect(pace(person("female", 60, 5, 0, 100, "sedentary", "lose_fat"))).toEqual({
      kind: "minimum", goal: "lose_fat", storeBp: -25, kcalMin: 1214, tdeeKcal: 1134 });
  });

  it("man 30, 6'0\", 180 lb, active, build muscle: three distinct chips", () => {
    const result = pace(person("male", 30, 6, 0, 180, "active", "gain_muscle"));
    expect(result).toMatchObject({ tdeeKcal: 2812, preselectedBp: 20 });
    expect(chips(result)).toEqual([["Gentle", 2902, 0.2, null], ["Steady", 2992, 0.4, null],
      ["Faster", 3037, 0.5, null]]);
  });

  it("woman 28, 5'5\", 130 lb, moderate, build muscle: Faster's label equals Steady's, dropped", () => {
    const result = pace(person("female", 28, 5, 5, 130, "moderate", "gain_muscle"));
    expect(result).toMatchObject({ tdeeKcal: 1849, kcalMin: 1274 });
    expect(chips(result)).toEqual([["Gentle", 1914, 0.1, null], ["Steady", 1979, 0.3, null]]);
  });
});

describe("paceChoices — routes", () => {
  it("asks nothing for recomp and maintain", () => {
    expect(pace(person("female", 35, 5, 4, 150, "light", "recomp"))).toEqual({ kind: "none", goal: "recomp" });
    expect(pace(person("female", 35, 5, 4, 150, "light", "maintain")).kind).toBe("none");
  });

  it("offers no pace to a held account", () => {
    for (const conditions of [["Pregnant"], ["Breastfeeding"], ["anorexia"], ["CKD"],
      ["Diet set by my clinician"]]) {
      expect(pace(person("female", 35, 5, 4, 150, "light", "lose_fat"),
        targetEligibility({ conditions })).kind).toBe("held");
    }
    expect(pace(person("female", 35, 5, 4, 150, "light", "lose_fat"),
      targetEligibility({ profiles: [{ profileId: "trying_to_conceive" }] })).kind).toBe("choices");
  });

  it("never offers more than three chips, every chip a preset", () => {
    for (const lb of [100, 130, 160, 200, 260, 330]) {
      for (const goal of ["lose_fat", "gain_muscle"] as const) {
        const result = pace(person("male", 33, 5, 9, lb, "moderate", goal));
        if (result.kind !== "choices") continue;
        expect(result.choices.length).toBeLessThanOrEqual(3);
        expect(new Set(result.choices.map((c) => c.targetKcal)).size).toBe(result.choices.length);
        expect(result.choices.map((c) => c.bp).every((bp) => [-25, -50, -75, 10, 20, 25].includes(bp)))
          .toBe(true);
      }
    }
  });
});

describe("rounding and speech", () => {
  it("rounds the magnitude half-up to 0.1 lb", () => {
    expect(roundLbHalfUp(0.45)).toBe(0.5);
    expect(roundLbHalfUp(-0.449)).toBe(0.4);
    expect(roundLbHalfUp(0.04)).toBe(0);
  });

  it("maps '2 lb a week' to the fastest chip the plan supports and says it was capped", () => {
    const result = pace(person("male", 40, 5, 10, 200, "light", "lose_fat"));
    if (result.kind !== "choices") throw new Error("expected chips");
    expect(chipForRequestedPace(result.choices, 2)).toMatchObject({ choice: { label: "Steady" }, capped: true });
    expect(chipForRequestedPace(result.choices, 0.5)).toMatchObject({ choice: { label: "Gentle" }, capped: false });
    expect(chipForRequestedPace(result.choices, 0.2)).toMatchObject({ choice: { label: "Gentle" } });
  });
});

describe("impliedDate — §2d", () => {
  const steady = { lbPerWeek: 1, underTenth: false, bound: null, effectiveRatePctWeek: -0.5 };
  const base = { goal: "lose_fat" as const, currentLb: 200, heightCm: 177.8, today: "2026-10-08" };

  it("estimates the week the goal weight is reached", () => {
    expect(impliedDate({ ...base, goalLb: 180, choice: steady }))
      .toEqual({ kind: "date", weeks: 20, date: "2027-02-25" });
  });

  it("shows no date on the wrong side, under BMI 18.5, at the minimum, or past two years", () => {
    expect(impliedDate({ ...base, goalLb: 210, choice: steady })).toMatchObject({ reason: "wrong_side" });
    expect(impliedDate({ ...base, goalLb: 120, choice: steady })).toMatchObject({ reason: "below_bmi" });
    expect(impliedDate({ ...base, goalLb: 180, choice: { ...steady, bound: "kcal_min" } }))
      .toMatchObject({ reason: "minimum_sets_pace" });
    expect(impliedDate({ ...base, goalLb: 140, choice: { ...steady, lbPerWeek: 0.5 } }))
      .toMatchObject({ reason: "too_long" });
    expect(impliedDate({ ...base, goalLb: null, choice: steady })).toMatchObject({ reason: "no_goal_weight" });
    expect(impliedDate({ ...base, goal: "maintain", goalLb: 180, choice: steady }))
      .toMatchObject({ reason: "no_pace" });
  });

  it("works in the gain direction", () => {
    expect(impliedDate({ ...base, goal: "gain_muscle", currentLb: 150, goalLb: 160,
      choice: { ...steady, lbPerWeek: 0.4, effectiveRatePctWeek: 0.2 } }))
      .toMatchObject({ kind: "date", weeks: 25 });
  });
});

describe("inferActivity — §1b table", () => {
  it.each([
    ["mostly_sitting", [], "sedentary"], ["mostly_sitting", [1, 3], "light"],
    ["mostly_sitting", [1, 3, 5], "light"], ["mostly_sitting", [0, 1, 2, 3, 4], "moderate"],
    ["feet_some", [], "light"], ["feet_some", [1, 2, 3], "moderate"],
    ["feet_most", [2], "moderate"], ["feet_most", [1, 2, 3], "active"],
    ["hard_work", [], "active"], ["hard_work", [0, 1, 2, 3, 4, 5], "very_active"],
  ] as const)("%s with %j workout days is %s", (dailyMovement, trainingWeekdays, level) => {
    expect(inferActivity({ dailyMovement, trainingWeekdays })).toBe(level);
  });

  it("starts low when both are skipped, and duplicates count once", () => {
    expect(inferActivity({})).toBe("sedentary");
    expect(inferActivity({ dailyMovement: "mostly_sitting", trainingWeekdays: [1, 1, 1, 1, 1] }))
      .toBe("light");
  });

  it("never rises past the table: more movement or more days never lowers the level", () => {
    const order = ["sedentary", "light", "moderate", "active", "very_active"];
    const rows = ["mostly_sitting", "feet_some", "feet_most", "hard_work"] as const;
    const level = (row: number, days: number) => order.indexOf(inferActivity({
      dailyMovement: rows[row], trainingWeekdays: [0, 1, 2, 3, 4, 5, 6].slice(0, days) }));
    for (let row = 0; row < rows.length; row += 1) {
      for (let days = 0; days <= 7; days += 1) {
        if (row > 0) expect(level(row, days)).toBeGreaterThanOrEqual(level(row - 1, days));
        if (days > 0) expect(level(row, days)).toBeGreaterThanOrEqual(level(row, days - 1));
        // Only hard physical work on five or more days reaches the top factor (1.70).
        if (level(row, days) === 4) expect([row, days >= 5]).toEqual([3, true]);
      }
    }
  });
});
