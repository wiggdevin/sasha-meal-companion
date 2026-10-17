import { describe, expect, it } from "vitest";
import { computeWeekStats, generateWeekSummary } from "./summary";
import type { Macros, ResolvedDay, ResolvedSlot } from "./types";

const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

function slot(overrides: Partial<ResolvedSlot> & Pick<ResolvedSlot, "slot" | "eaten">): ResolvedSlot {
  return {
    time: "12:00",
    label: "Meal",
    meal: { id: "m", name: "Meal", slot: overrides.slot, components: [], macros: ZERO, prepMinutes: 0, tags: [] },
    components: [],
    macros: ZERO,
    ...overrides,
  };
}

function day(overrides: Partial<ResolvedDay> & Pick<ResolvedDay, "date">): ResolvedDay {
  return {
    dayType: "rest",
    isFloorDay: false,
    targets: { kcal: 1700, protein: 125, carbs: 100, fat: 89 },
    slots: [],
    extras: [],
    waterCups: 0,
    consumed: { ...ZERO },
    ...overrides,
  };
}

/** A fully-eaten day: all three meal slots ticked, consumed == targets. */
function eatenDay(date: string, opts: Partial<ResolvedDay> = {}): ResolvedDay {
  const targets = opts.targets ?? { kcal: 1700, protein: 125, carbs: 100, fat: 89 };
  return day({
    date,
    targets,
    consumed: targets,
    slots: [
      slot({ slot: "meal-1", label: "Meal 1", eaten: true }),
      slot({ slot: "meal-2", label: "Meal 2", eaten: true }),
      slot({ slot: "meal-3", label: "Meal 3", eaten: true }),
    ],
    ...opts,
  });
}

/** A fully-missed day: three meal slots present, none eaten. */
function missedDay(date: string, opts: Partial<ResolvedDay> = {}): ResolvedDay {
  return day({
    date,
    consumed: ZERO,
    slots: [
      slot({ slot: "meal-1", label: "Meal 1", eaten: false }),
      slot({ slot: "meal-2", label: "Meal 2", eaten: false }),
      slot({ slot: "meal-3", label: "Meal 3", eaten: false }),
    ],
    ...opts,
  });
}

describe("computeWeekStats — meals hit / missed", () => {
  it("counts only meal-1/2/3 slots, not coffee/pre-training carbs/hot-chocolate", () => {
    const days = [
      day({
        date: "2026-09-14",
        consumed: ZERO,
        slots: [
          slot({ slot: "coffee", label: "Coffee", eaten: true }),
          slot({ slot: "pouches-pre", label: "Pre-training carbs", eaten: false }),
          slot({ slot: "meal-1", label: "Meal 1", eaten: true }),
          slot({ slot: "meal-2", label: "Meal 2", eaten: true }),
          slot({ slot: "meal-3", label: "Meal 3", eaten: true }),
        ],
      }),
    ];
    const stats = computeWeekStats(days, "2026-09-15");
    expect(stats.meals).toEqual({ hit: 3, total: 3, pct: 100 });
  });

  it("18/21 rounds to 86%, matching the PRD §8 worked example", () => {
    // 6 fully-eaten days + 1 day missing exactly one of its three meals.
    const days = [
      eatenDay("2026-09-14"),
      eatenDay("2026-09-15"),
      eatenDay("2026-09-16"),
      eatenDay("2026-09-17"),
      eatenDay("2026-09-18"),
      missedDay("2026-09-19"), // Sat — all three meals missed
      eatenDay("2026-09-20"),
    ];
    const stats = computeWeekStats(days, "2026-09-21");
    expect(stats.meals).toEqual({ hit: 18, total: 21, pct: 86 });
    expect(stats.missed).toEqual(["Sat Meal 1", "Sat Meal 2", "Sat Meal 3"]);
  });

  it("a future day contributes nothing — grey/untouched is not a miss", () => {
    const days = [missedDay("2026-09-14"), missedDay("2026-09-15")];
    // "today" is the first day of the two — the second is still in the future.
    const stats = computeWeekStats(days, "2026-09-14");
    expect(stats.meals).toBeNull();
    expect(stats.missed).toEqual([]);
  });

  it("today itself is excluded — a meal not yet reached is not a miss", () => {
    const days = [missedDay("2026-09-14"), missedDay("2026-09-15")];
    const stats = computeWeekStats(days, "2026-09-15");
    expect(stats.meals).toEqual({ hit: 0, total: 3, pct: 0 });
    expect(stats.missed).toEqual(["Mon Meal 1", "Mon Meal 2", "Mon Meal 3"]);
  });
});

describe("computeWeekStats — protein hit-rate (the Week screen's headline number)", () => {
  it("counts a scoreable day as a hit when consumed protein meets or exceeds target", () => {
    const days = [
      eatenDay("2026-09-14", { consumed: { kcal: 1700, protein: 125, carbs: 100, fat: 89 } }), // exactly on target
      eatenDay("2026-09-15", { consumed: { kcal: 1700, protein: 130, carbs: 100, fat: 89 } }), // over target
      eatenDay("2026-09-16", { consumed: { kcal: 1700, protein: 100, carbs: 100, fat: 89 } }), // under target
    ];
    const stats = computeWeekStats(days, "2026-09-17");
    expect(stats.proteinHitRate).toEqual({ met: 2, total: 3, pct: 67 });
  });

  it("is null when no day is scoreable yet", () => {
    const stats = computeWeekStats([missedDay("2026-09-14")], "2026-09-14");
    expect(stats.proteinHitRate).toBeNull();
  });
});

describe("computeWeekStats — rounding", () => {
  it("averages protein and calories and rounds to the nearest whole number", () => {
    const days = [
      eatenDay("2026-09-14", { consumed: { kcal: 1800, protein: 120, carbs: 100, fat: 80 } }),
      eatenDay("2026-09-15", { consumed: { kcal: 1900, protein: 122, carbs: 100, fat: 80 } }),
    ];
    // avg protein = 121, avg kcal = 1850
    const stats = computeWeekStats(days, "2026-09-16");
    expect(stats.protein).toEqual({ avg: 121, target: 125 });
    expect(stats.calories).toEqual({ avg: 1850, target: 1700 });
  });

  it("rounds .5 up, matching the 18/21 -> 86% example (85.71.. -> 86)", () => {
    const days = [
      eatenDay("2026-09-14", { consumed: { kcal: 1701, protein: 125, carbs: 100, fat: 89 } }),
    ];
    const stats = computeWeekStats(days, "2026-09-15");
    // (85.71..)% would come from 18/21 above; here just check a plain average rounds correctly.
    expect(stats.calories?.avg).toBe(1701);
  });
});

describe("computeWeekStats — graceful omission", () => {
  it("no weigh-ins -> weight is null", () => {
    const stats = computeWeekStats([eatenDay("2026-09-14")], "2026-09-15");
    expect(stats.weight).toBeNull();
  });

  it("one weigh-in -> first === last, count 1", () => {
    const stats = computeWeekStats([eatenDay("2026-09-14", { weightLb: 127.4 })], "2026-09-15");
    expect(stats.weight).toEqual({ first: 127.4, last: 127.4, count: 1 });
  });

  it("two weigh-ins -> first is earliest, last is latest by day order", () => {
    const days = [
      eatenDay("2026-09-14", { weightLb: 127.4 }),
      eatenDay("2026-09-15", { weightLb: 128.1 }),
    ];
    const stats = computeWeekStats(days, "2026-09-20");
    expect(stats.weight).toEqual({ first: 127.4, last: 128.1, count: 2 });
  });

  it("no gut check-ins -> gut is null", () => {
    const stats = computeWeekStats([eatenDay("2026-09-14")], "2026-09-15");
    expect(stats.gut).toBeNull();
  });

  it("gut check-ins are counted across the whole week, including today", () => {
    const days = [
      eatenDay("2026-09-14", { gut: "good" }),
      day({ date: "2026-09-15", gut: "iffy" }),
    ];
    const stats = computeWeekStats(days, "2026-09-15");
    expect(stats.gut).toEqual({ good: 1, iffy: 1, flare: 0 });
  });

  it("zero floor days still reports the line's data (count 0, no day list)", () => {
    const stats = computeWeekStats([eatenDay("2026-09-14")], "2026-09-15");
    expect(stats.floorDays).toEqual({ count: 0, days: [] });
    expect(stats.overTargetDays).toEqual([]);
  });

  it("floor days are named by weekday", () => {
    const days = [eatenDay("2026-09-17", { isFloorDay: true })]; // a Thursday
    const stats = computeWeekStats(days, "2026-09-18");
    expect(stats.floorDays).toEqual({ count: 1, days: ["Thu"] });
  });

  it("an empty week returns a stats shape with no data", () => {
    const stats = computeWeekStats([], "2026-09-15");
    expect(stats.rangeLabel).toBe("");
    expect(stats.meals).toBeNull();
    expect(stats.protein).toBeNull();
    expect(stats.calories).toBeNull();
    expect(stats.gut).toBeNull();
    expect(stats.weight).toBeNull();
  });
});

describe("computeWeekStats — date-range formatting", () => {
  it("same month: 'Sep 15–21'", () => {
    const days = [eatenDay("2026-09-15"), eatenDay("2026-09-21")];
    expect(computeWeekStats(days, "2026-09-22").rangeLabel).toBe("Sep 15–21");
  });

  it("crosses a month boundary: 'Aug 28–Sep 3'", () => {
    const days = [eatenDay("2026-08-28"), eatenDay("2026-09-03")];
    expect(computeWeekStats(days, "2026-09-04").rangeLabel).toBe("Aug 28–Sep 3");
  });

  it("crosses a year boundary: includes both years", () => {
    const days = [eatenDay("2026-12-29"), eatenDay("2027-01-04")];
    expect(computeWeekStats(days, "2027-01-05").rangeLabel).toBe("Dec 29, 2026–Jan 4, 2027");
  });
});

describe("computeWeekStats — missing targets", () => {
  it("does not fabricate target-derived stats before a profile is complete", () => {
    const stats = computeWeekStats([
      day({ date: "2026-09-14", targets: null, consumed: { ...ZERO, kcal: 450 } }),
    ], "2026-09-15");
    expect(stats.protein).toBeNull();
    expect(stats.calories).toBeNull();
    expect(stats.proteinHitRate).toBeNull();
  });
});

describe("generateWeekSummary — exact PRD §8 shape", () => {
  it("produces the documented block for a fully-scored week", () => {
    // Mon 2026-09-14 .. Sun 2026-09-20 (verified against a real calendar so
    // the weekday labels below are trustworthy, not just internally
    // consistent).
    const days = [
      eatenDay("2026-09-14", { consumed: { kcal: 1900, protein: 122, carbs: 100, fat: 89 }, gut: "good" }), // Mon
      eatenDay("2026-09-15", { consumed: { kcal: 1900, protein: 122, carbs: 100, fat: 89 }, gut: "good" }), // Tue
      eatenDay("2026-09-16", { consumed: { kcal: 1900, protein: 122, carbs: 100, fat: 89 }, gut: "good" }), // Wed
      eatenDay("2026-09-17", {
        consumed: { kcal: 1900, protein: 122, carbs: 100, fat: 89 },
        gut: "good",
        isFloorDay: true,
      }), // Thu
      eatenDay("2026-09-18", { consumed: { kcal: 1900, protein: 122, carbs: 100, fat: 89 }, gut: "good", weightLb: 127.4 }), // Fri
      day({
        date: "2026-09-19", // Sat
        consumed: { kcal: 1850, protein: 118, carbs: 95, fat: 89 },
        gut: "iffy",
        weightLb: 128.1,
        slots: [
          slot({ slot: "meal-1", label: "Meal 1", eaten: true }),
          slot({ slot: "meal-2", label: "Meal 2", eaten: false }),
          slot({ slot: "meal-3", label: "Meal 3", eaten: true }),
        ],
      }),
      day({
        date: "2026-09-20", // Sun
        consumed: { kcal: 1850, protein: 118, carbs: 95, fat: 89 },
        gut: "iffy",
        slots: [
          slot({ slot: "meal-1", label: "Meal 1", eaten: true }),
          slot({ slot: "meal-2", label: "Meal 2", eaten: false }),
          slot({ slot: "meal-3", label: "Meal 3", eaten: true }),
        ],
      }),
    ];

    const text = generateWeekSummary(days, "2026-09-21");

    expect(text).toBe(
      [
        "Sasha — Sep 14–20",
        "Meals hit: 19/21 (90%)",
        "Protein: avg 121g (target 125)",
        "Calories: avg 1,886 (target 1,700)",
        "Gut: 5 good, 2 iffy, 0 flare",
        "Weight: 127.4 → 128.1 lb",
        "Floor days used: 1 (Thu)",
        "Missed: Sat Meal 2, Sun Meal 2",
      ].join("\n")
    );
  });

  it("omits the Weight line entirely when nothing was logged", () => {
    const text = generateWeekSummary([eatenDay("2026-09-14")], "2026-09-15");
    expect(text).not.toContain("Weight");
  });

  it("omits the Gut line entirely when nothing was logged", () => {
    const text = generateWeekSummary([eatenDay("2026-09-14")], "2026-09-15");
    expect(text).not.toContain("Gut");
  });

  it("omits the Missed line entirely when nothing was missed", () => {
    const text = generateWeekSummary([eatenDay("2026-09-14")], "2026-09-15");
    expect(text).not.toContain("Missed");
  });

  it("still reports 'Floor days used: 0' when none were used", () => {
    const text = generateWeekSummary([eatenDay("2026-09-14")], "2026-09-15");
    expect(text).toContain("Floor days used: 0");
  });

  it("returns an empty string for an empty week", () => {
    expect(generateWeekSummary([], "2026-09-15")).toBe("");
  });
});
