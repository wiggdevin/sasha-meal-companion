import { describe, expect, it } from "vitest";
import { dayTypeFor, resolveSlotTimes, shiftTime, slotListFor } from "./plan";

describe("dayTypeFor", () => {
  it("uses rest when no training weekdays are configured", () => {
    expect(dayTypeFor("2026-09-07")).toBe("rest");
    expect(dayTypeFor("2026-09-07", undefined, { trainingWeekdays: [] })).toBe("rest");
  });

  it("uses account weekdays and lets a date override win", () => {
    const settings = { trainingWeekdays: [1, 3] };
    expect(dayTypeFor("2026-09-07", undefined, settings)).toBe("training-10");
    expect(dayTypeFor("2026-09-09", undefined, settings)).toBe("training-7-fasted");
    expect(dayTypeFor("2026-09-10", undefined, settings)).toBe("rest");
    expect(dayTypeFor("2026-09-07", "rest", settings)).toBe("rest");
  });
});

describe("slot schedules", () => {
  it("returns the complete slot list for each day type", () => {
    for (const type of ["training-10", "training-7-fasted", "rest"] as const) {
      expect(slotListFor(type)).toEqual(["meal-1", "meal-2", "meal-3"]);
    }
  });

  it("applies per-slot times and the whole-day shift", () => {
    const times = resolveSlotTimes("training-10", {
      slotTimes: { "meal-1": "12:30" }, shiftMinutes: -90,
    });
    expect(times.find((slot) => slot.slot === "meal-1")?.time).toBe("11:00");
    expect(times.find((slot) => slot.slot === "meal-2")?.time).toBe("11:00");
  });
});

describe("shiftTime", () => {
  it("shifts and clamps inside one calendar day", () => {
    expect(shiftTime("08:00", 90)).toBe("09:30");
    expect(shiftTime("00:30", -90)).toBe("00:00");
    expect(shiftTime("23:30", 90)).toBe("23:59");
  });
});
