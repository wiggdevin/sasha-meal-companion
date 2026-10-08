// Onboarding v2 G4: the fast path reads the plan answers (training weekdays, meals a day, first
// meal, a spoken pace, a goal weight) with the same banding rules as the body facts, and the
// widened facts schema accepts exactly those shapes.
import { describe, expect, it } from "vitest";
import { extractFastPath } from "@/lib/coach/onboarding-fast-path";
import { PLAN_GHOST, PLAN_HIGH } from "@/lib/coach/onboarding-fast-path-plan";
import { onboardingFactsSchema, onboardingModelFactsSchema } from "@/lib/coach/ui-blocks";
import { shiftForFirstMeal } from "@/lib/plan";

const NOW = new Date("2026-10-08T12:00:00Z");
const read = (text: string) => extractFastPath(text, NOW);

describe("training weekdays", () => {
  it.each([
    ["I lift Mon, Wed and Fri", [1, 3, 5]],
    ["I work out Monday through Friday", [1, 2, 3, 4, 5]],
    ["gym on tues and thurs", [2, 4]],
    ["I train on weekends", [0, 6]],
    ["I run every day", [0, 1, 2, 3, 4, 5, 6]],
    ["I lift Mon-Wed but not Sunday", [1, 2, 3]],
    ["I don't train on weekends, I lift Mon and Thu", [1, 4]],
  ])("%s → %j", (text, days) => {
    const r = read(text);
    expect(r.trainingWeekdays).toEqual(days);
    expect(r.confidence.trainingWeekdays).toBe(PLAN_HIGH);
  });

  it("reads 'I don't work out' as no workout days, and day names without a workout as nothing", () => {
    expect(read("I don't work out right now")).toMatchObject({ trainingWeekdays: [] });
    expect(read("I sat in the sun on Saturday").trainingWeekdays).toBeUndefined();
  });

  it("never hands anyone a Wednesday-only fasted week by default", () => {
    expect(read("I want to lose weight").trainingWeekdays).toBeUndefined();
  });
});

describe("meals a day and first meal", () => {
  it("reads a meal count with and without its anchor", () => {
    expect(read("I eat 3 meals a day")).toMatchObject({ mealsPerDay: 3, confidence: { mealsPerDay: PLAN_HIGH } });
    expect(read("five times per day")).toMatchObject({ mealsPerDay: 5 });
    expect(read("usually 4 meals")).toMatchObject({ mealsPerDay: 4, confidence: { mealsPerDay: PLAN_GHOST } });
    expect(read("I don't eat 3 meals a day").mealsPerDay).toBeUndefined();
    expect(read("I eat 9 meals a day").mealsPerDay).toBeUndefined();
  });

  it("reads the first meal time in 24-hour form", () => {
    expect(read("breakfast at 7:30am")).toMatchObject({ firstMealTime: "07:30",
      confidence: { firstMealTime: PLAN_HIGH } });
    expect(read("my first meal is around 10 am")).toMatchObject({ firstMealTime: "10:00" });
    expect(read("I eat first at 1")).toMatchObject({ firstMealTime: "13:00",
      confidence: { firstMealTime: PLAN_GHOST } });
    expect(read("breakfast at 12 pm")).toMatchObject({ firstMealTime: "12:00" });
  });

  it("turns the first meal into the whole-day shift from the layout's first time", () => {
    expect(shiftForFirstMeal("07:30")).toBe(-30);
    expect(shiftForFirstMeal("10:00", { mealsPerDay: 2 })).toBe(60);
    expect(shiftForFirstMeal("7:30")).toBeNull();
  });
});

describe("pace and goal weight", () => {
  it("keeps a spoken pace as asked, in lb a week", () => {
    expect(read("I want to lose 2 pounds a week")).toMatchObject({ requestedPaceLbPerWeek: 2, goal: "lose_fat" });
    expect(read("about a pound a week")).toMatchObject({ requestedPaceLbPerWeek: 1 });
    expect(read("half a pound a week is fine")).toMatchObject({ requestedPaceLbPerWeek: 0.5 });
    expect(read("1 kg per week")).toMatchObject({ requestedPaceLbPerWeek: 2.2 });
  });

  it("reads a goal weight and never as the current weight", () => {
    const r = read("I weigh 210 lbs and want to get down to 180 lbs");
    expect(r.weightKg).toBeCloseTo(95.3, 1);
    expect(r.targetWeightKg).toBeCloseTo(81.6, 1);
    expect(r.confidence.targetWeightKg).toBe(PLAN_HIGH);
  });

  it("never reads 'lose 50 pounds' as the current weight", () => {
    const r = read("I want to lose 50 pounds, I'm 5'8\"");
    expect(r.weightKg).toBeUndefined();
    expect(r.goal).toBe("lose_fat");
    expect(read("lose 30 lbs, I weigh 250 lbs").weightKg).toBeCloseTo(113.4, 1);
  });
});

describe("the widened facts schema", () => {
  it("accepts the plan answers with their confidence entries", () => {
    expect(onboardingFactsSchema.safeParse({ goal: "lose_fat", goalRateBpWeek: -50,
      trainingWeekdays: [1, 3, 5], dailyMovement: "feet_some", mealsPerDay: 4, firstMealTime: "07:30",
      targetWeightKg: 80, requestedPaceLbPerWeek: 1,
      confidence: { goal: 0.9, goalRateBpWeek: 1, trainingWeekdays: 0.9, dailyMovement: 1,
        mealsPerDay: 0.9, firstMealTime: 0.9, targetWeightKg: 0.9, requestedPaceLbPerWeek: 0.9 } })
      .success).toBe(true);
  });

  it("refuses a rate off the presets or against the goal, repeated weekdays and bad times", () => {
    const parse = (extra: Record<string, unknown>, confidence: Record<string, number>) =>
      onboardingFactsSchema.safeParse({ ...extra, confidence }).success;
    expect(parse({ goalRateBpWeek: -100 }, { goalRateBpWeek: 1 })).toBe(false);
    expect(parse({ goal: "lose_fat", goalRateBpWeek: 20 }, { goal: 1, goalRateBpWeek: 1 })).toBe(false);
    expect(parse({ trainingWeekdays: [1, 1] }, { trainingWeekdays: 1 })).toBe(false);
    expect(parse({ firstMealTime: "7:30" }, { firstMealTime: 1 })).toBe(false);
    expect(parse({ mealsPerDay: 3 }, {})).toBe(false);
  });

  it("keeps every plan answer out of the model's schema", () => {
    for (const key of ["goalRateBpWeek", "targetWeightKg", "trainingWeekdays", "mealsPerDay",
      "firstMealTime", "dailyMovement", "requestedPaceLbPerWeek"]) {
      expect(onboardingModelFactsSchema.safeParse({ [key]: 1, confidence: {} }).success, key).toBe(false);
    }
  });

  it("emits only schema-valid facts from the fast path", () => {
    for (const text of ["I lift Mon, Wed and Fri, 3 meals a day, breakfast at 7am, a pound a week",
      "I weigh 210 lbs and want to get down to 180 lbs", "I don't work out right now"]) {
      expect(onboardingFactsSchema.safeParse(read(text)).success, text).toBe(true);
    }
  });
});
