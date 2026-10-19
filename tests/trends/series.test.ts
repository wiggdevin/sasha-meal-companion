import { describe, expect, it } from "vitest";
import { defaultStore } from "@/lib/store";
import {
  buildTrendDays, dailyPoints, dayIntake, formatMetric, goalProgress, isoShift, sevenDayMean, weekdayShort,
  weeklyPoints, windowDates, type TrendDay,
} from "@/lib/trends/series";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { LoggedFood, Macros, Store, StoredDay } from "@/lib/types";

const TODAY = "2026-10-19";
const DAY: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };

function entry(id: string, kcal: number, protein = 20, over: Partial<LoggedFood> = {}): LoggedFood {
  return { id, foodId: "f", name: "Pasta", portionLabel: "1 plate", qty: 1, grams: 300,
    macros: { kcal, protein, carbs: 10, fat: 5 }, at: "2026-10-18T13:00:00Z", ...over };
}

function store(days: Record<string, StoredDay> = {}, revisionFrom?: string): Store {
  const base = defaultStore();
  base.days = days;
  if (revisionFrom) {
    base.settings = { ...base.settings, activeTargetProfile: { revision: 1, rev: 1, effectiveFrom: revisionFrom,
      training: DAY, rest: DAY, pins: { trainingKcal: null, restKcal: null, proteinG: null } } as never };
  }
  return base;
}

function row(date: string, over: Partial<DailyHealthRow> = {}): DailyHealthRow {
  return { local_date: date, steps: null, active_kcal: null, sleep_minutes: null, body_mass_kg: null, sources: [],
    resting_heart_rate: null, hrv_sdnn: null, readiness_score: null, provenance: {}, ...over };
}

function build(s: Store, opts: Partial<Parameters<typeof buildTrendDays>[0]> = {}): TrendDay[] {
  return buildTrendDays({ store: s, today: TODAY, dates: windowDates(TODAY, 28), cups: null, waterGoal: null,
    health: null, ...opts });
}

describe("dates", () => {
  it("shifts across month ends and lists the window oldest first", () => {
    expect(isoShift("2026-10-01", -1)).toBe("2026-09-30");
    expect(windowDates(TODAY, 3)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(weekdayShort("2026-10-19")).toBe("Mon");
  });
});

describe("dayIntake", () => {
  it("is a gap, never 0, when the day has no entry, no eaten slot and no eaten recipe", () => {
    expect(dayIntake(undefined)).toBeNull();
    expect(dayIntake({ date: "2026-10-18", notes: { "meal-1": "x" } })).toBeNull();
    const days = build(store({ "2026-10-18": { date: "2026-10-18", gut: "good" } }));
    expect(days.find((d) => d.date === "2026-10-18")?.kcal).toBeNull();
  });

  it("sums log entries and eaten recipe snapshots", () => {
    const day: StoredDay = { date: "2026-10-18", extras: [entry("a", 500, 30)],
      eaten: { "meal-1": "2026-10-18T08:00:00Z" },
      consumedSlots: { "meal-1": { baseMealId: "recipe:x", title: "Oats",
        components: [{ name: "Oats", qty: 1, unit: "cup", role: "carb", macros: { kcal: 300, protein: 10, carbs: 50, fat: 5 } }] } } };
    expect(dayIntake(day)).toEqual({ kcal: 800, protein: 40, partial: false });
  });

  it("marks a partial day: a partly measured entry, or a ticked slot nothing describes", () => {
    expect(dayIntake({ date: "d", extras: [entry("a", 400, 20, { nutritionPartial: true })] })?.partial).toBe(true);
    const ticked = dayIntake({ date: "d", eaten: { "meal-2": "2026-10-18T12:00:00Z" } });
    expect(ticked).toEqual({ kcal: 0, protein: 0, partial: true });
  });

  it("counts a log filed under a slot once, not beside the slot", () => {
    const day: StoredDay = { date: "d", extras: [entry("a", 600, 30, { slot: "meal-1" })],
      eaten: { "meal-1": "2026-10-18T08:00:00Z" } };
    expect(dayIntake(day)).toEqual({ kcal: 600, protein: 30, partial: false });
  });
});

describe("targets", () => {
  it("has no target before the first revision", () => {
    const days = build(store({}, "2026-10-10"));
    expect(days.find((d) => d.date === "2026-10-09")?.kcalTarget).toBeNull();
    expect(days.find((d) => d.date === "2026-10-10")?.kcalTarget).toBe(2000);
    expect(build(store()).every((d) => d.kcalTarget === null)).toBe(true);
  });

  it("treats today as partial until it is marked fully logged", () => {
    const days = build(store({ [TODAY]: { date: TODAY, extras: [entry("a", 500)] } }));
    expect(days.at(-1)).toMatchObject({ today: true, kcal: 500, intakePartial: true });
    const marked = build(store({ [TODAY]: { date: TODAY, extras: [entry("a", 500)], dayCompleteAt: "x" } }));
    expect(marked.at(-1)?.intakePartial).toBe(false);
  });
});

describe("health and water", () => {
  it("reads kg and shows the account's unit, a missing row a gap", () => {
    const days = build(store(), { health: [row("2026-10-18", { body_mass_kg: 70 })] });
    const points = dailyPoints(days, "weight", "lb");
    expect(points.at(-2)?.value).toBe(154.3);
    expect(dailyPoints(days, "weight", "kg").at(-2)?.value).toBe(70);
    expect(points.at(-1)?.value).toBeNull();
  });

  it("keeps a stored 0 cups as 0 and a missing water row as a gap", () => {
    const cups = new Map([["2026-10-17", 0], ["2026-10-18", 6]]);
    const days = build(store(), { cups, waterGoal: () => 8 });
    const water = dailyPoints(days, "water");
    expect(water.slice(-3).map((p) => p.value)).toEqual([0, 6, null]);
    expect(water.at(-1)?.target).toBe(8);
  });
});

describe("weekly means", () => {
  it("averages only the days that have a value, and says how many", () => {
    const daysIn: Record<string, StoredDay> = {};
    for (const [date, kcal] of [["2026-10-13", 1800], ["2026-10-14", 2200]] as const) {
      daysIn[date] = { date, extras: [entry(date, kcal)] };
    }
    const weeks = weeklyPoints(build(store(daysIn)), "kcal");
    expect(weeks).toHaveLength(4);
    expect(weeks.at(-1)).toMatchObject({ date: "2026-10-13", end: "2026-10-19", value: 2000, days: 2, span: 7 });
    expect(weeks[0]).toMatchObject({ value: null, days: 0 });
  });
});

describe("goal progress and averages", () => {
  it("judges only whole days with a target", () => {
    const daysIn: Record<string, StoredDay> = {
      "2026-10-16": { date: "2026-10-16", extras: [entry("a", 1950)] },
      "2026-10-17": { date: "2026-10-17", extras: [entry("b", 2500)] },
      "2026-10-18": { date: "2026-10-18", extras: [entry("c", 1000, 10, { nutritionPartial: true })] },
    };
    const days = build(store(daysIn, "2026-09-01"));
    expect(goalProgress(dailyPoints(days, "kcal"), "kcal")).toEqual({ met: 1, of: 2 });
    expect(goalProgress(dailyPoints(build(store(daysIn)), "kcal"), "kcal")).toBeNull();
    expect(sevenDayMean(days, "kcal")).toBe(2225);
  });

  it("formats each measure in plain words", () => {
    expect(formatMetric("kcal", 1840)).toBe("1,840 kcal");
    expect(formatMetric("sleep", 440)).toBe("7h 20m");
    expect(formatMetric("water", 8, { waterUnit: "cups" })).toBe("8 cups");
  });
});
