import { describe, expect, it } from "vitest";
import { eatenClock, entryOccasion, scheduledClock, type MealSchedule } from "./schedule";

const FOUR: MealSchedule = { slotTimes: {}, shiftMinutes: 0, mealsPerDay: 4, trainingKcal: null };

describe("the occasion a log entry was eaten at (D1)", () => {
  it("reads a meal slot's clock off the account's schedule", () => {
    // Four meals: 08:00, 11:30, 15:00, 18:30.
    expect(entryOccasion({ slot: "meal-1" }, FOUR)).toEqual({ occasion: "breakfast", source: "slot_clock" });
    expect(entryOccasion({ slot: "meal-2" }, FOUR)).toEqual({ occasion: "lunch", source: "slot_clock" });
    expect(entryOccasion({ slot: "meal-3" }, FOUR)).toEqual({ occasion: "snack", source: "slot_clock" });
    expect(entryOccasion({ slot: "meal-4" }, FOUR)).toEqual({ occasion: "dinner", source: "slot_clock" });
  });

  it("follows the account's own slot times and whole-day shift", () => {
    const late = { ...FOUR, slotTimes: { "meal-1": "11:00" } };
    expect(entryOccasion({ slot: "meal-1" }, late).occasion).toBe("lunch");
    expect(scheduledClock({ ...FOUR, shiftMinutes: 180 }, "meal-1")).toBe("11:00");
  });

  it("takes the meal count from the target when the account chose none", () => {
    // ≤ 1800 kcal: three meals, the third at 18:30; 2601+: five, the third at 13:30.
    expect(scheduledClock({ ...FOUR, mealsPerDay: null, trainingKcal: 1700 }, "meal-3")).toBe("18:30");
    expect(scheduledClock({ ...FOUR, mealsPerDay: null, trainingKcal: 3000 }, "meal-3")).toBe("13:30");
  });

  it("uses that day's time edit for the slot before the schedule", () => {
    expect(entryOccasion({ slot: "meal-1", dayTime: "13:00" }, FOUR).occasion).toBe("lunch");
    // An unreadable edit is ignored.
    expect(entryOccasion({ slot: "meal-1", dayTime: "1pm-ish" }, FOUR).occasion).toBe("breakfast");
  });

  it("an entry outside the schedule is read off the time it was eaten, in its own zone", () => {
    expect(eatenClock("2026-10-04T12:15:00Z", "America/New_York")).toBe("08:15");
    expect(entryOccasion({ slot: "snack", eatenAt: "2026-10-04T12:15:00Z", tz: "America/New_York" }, FOUR))
      .toEqual({ occasion: "breakfast", source: "slot_clock" });
    // A meal beyond the meal count has no scheduled clock either.
    expect(entryOccasion({ slot: "meal-6", eatenAt: "2026-10-04T23:30:00Z", tz: "UTC" }, FOUR).occasion).toBe("other");
    expect(entryOccasion({ slot: "snack" }, FOUR).occasion).toBe("other");
  });

  it("the account's occasion override for the slot wins", () => {
    expect(entryOccasion({ slot: "meal-2" }, { ...FOUR, overrides: { "meal-2": "breakfast" } }))
      .toEqual({ occasion: "breakfast", source: "override" });
  });
});
