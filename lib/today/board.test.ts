import { describe, expect, it, vi } from "vitest";
import type { ResolvedDay, ResolvedSlot, Store } from "@/lib/types";

const calls = vi.hoisted(() => ({ args: [] as { date: string; eligible?: ReadonlySet<string> }[], partialKcal: 0 }));
vi.mock("@/lib/resolve", () => ({
  dayHasPartialNutrition: (day: ResolvedDay) => day.extras.some((entry) => entry.nutritionPartial === true),
  resolveDay: (_store: Store, date: string, _water = 0, eligible?: ReadonlySet<string>): ResolvedDay => {
    calls.args.push({ date, eligible });
    const eaten = date === "2026-09-29";
    const partial = date === "2026-09-30";
    return {
      date, dayType: "rest", isFloorDay: false, targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
      slots: [{ slot: "meal-1", time: "08:00", label: "Breakfast", meal: { name: "Oats" } as ResolvedSlot["meal"],
        components: [], macros: { kcal: 500, protein: 30, carbs: 60, fat: 10 }, eaten }],
      extras: partial ? [{ id: "r", foodId: "recipe", name: "Stew", portionLabel: "serving", qty: 1, grams: 300,
        macros: { kcal: 300, protein: 20, carbs: 30, fat: 10 }, nutritionPartial: true, at: `${date}T12:00:00Z` }] : [],
      consumed: { kcal: eaten ? 500 : partial ? calls.partialKcal : 0, protein: 0, carbs: 0, fat: 0 }, waterCups: 0,
    };
  },
}));

const { nextMeal, nextStep, weekSummary } = await import("@/lib/today/board");
const { dayHeading } = await import("@/lib/today/calendar");

function slot(partial: Partial<ResolvedSlot> & Pick<ResolvedSlot, "slot" | "time">): ResolvedSlot {
  return { label: partial.slot, meal: { name: `Meal ${partial.slot}` } as ResolvedSlot["meal"], components: [],
    macros: { kcal: 400.4, protein: 30.6, carbs: 40, fat: 10 }, eaten: false, ...partial };
}

describe("nextMeal", () => {
  const slots = [slot({ slot: "meal-1", time: "08:00" }), slot({ slot: "meal-2", time: "12:30" }),
    slot({ slot: "meal-3", time: "18:00" })];

  it("points at the next uneaten meal still ahead today, rounding its figures", () => {
    expect(nextMeal(slots, 11 * 60)).toMatchObject({ slot: "meal-2", time: "12:30", kcal: 400, protein: 31 });
  });

  it("keeps a meal up to two hours past its time, then moves on", () => {
    expect(nextMeal(slots, 9 * 60 + 30)?.slot).toBe("meal-1");
    expect(nextMeal(slots, 10 * 60 + 30)?.slot).toBe("meal-2");
  });

  it("falls back to the earliest open meal when everything later is eaten, and to null when all are", () => {
    const late = slots.map((s) => (s.slot === "meal-1" ? s : { ...s, eaten: true }));
    expect(nextMeal(late, 22 * 60)?.slot).toBe("meal-1");
    expect(nextMeal(slots.map((s) => ({ ...s, eaten: true })), 8 * 60)).toBeNull();
  });

  it("skips unplanned slots and ignores the clock on other days", () => {
    expect(nextMeal([slot({ slot: "meal-1", time: "08:00", meal: null }), ...slots.slice(1)], null)?.slot).toBe("meal-2");
  });
});

describe("weekSummary", () => {
  it("resolves the viewed week with Today's verified plan inputs and counts days on plan honestly", () => {
    calls.args.length = 0;
    const eligible = new Set(["tofu"]);
    const week = weekSummary({} as Store, "2026-10-01", "2026-10-01", eligible);
    expect(calls.args.map((call) => call.date)).toEqual(
      ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(calls.args.every((call) => call.eligible === eligible)).toBe(true);
    expect(week.days.map((day) => day.letter).join("")).toBe("MTWTFSS");
    expect(week.elapsed).toBe(4);
    expect(week.onPlan).toBe(1);
    expect(week.averageKcal).toBe(500);
    expect(week.days.find((day) => day.isToday)?.date).toBe("2026-10-01");
  });

  it("marks a day holding a partly measured recipe serving, and only that day (#21)", () => {
    const week = weekSummary({} as Store, "2026-10-01", "2026-10-01");
    expect(week.days.filter((day) => day.partial).map((day) => day.date)).toEqual(["2026-09-30"]);
  });

  it("calls the week's average partial only when a day counted in it is partial", () => {
    // The partial day logged no measured calories: it is not in the average, so the average is whole.
    const whole = weekSummary({} as Store, "2026-10-01", "2026-10-01");
    expect(whole.averageKcal).toBe(500);
    expect(whole.averagePartial).toBe(false);
    calls.partialKcal = 300;
    try {
      const partial = weekSummary({} as Store, "2026-10-01", "2026-10-01");
      expect(partial.averageKcal).toBe(400);
      expect(partial.averagePartial).toBe(true);
    } finally { calls.partialKcal = 0; }
  });

  it("has no partial average when nothing is logged", () => {
    const week = weekSummary({} as Store, "2026-10-15", "2026-10-15");
    expect(week.averageKcal).toBeNull();
    expect(week.averagePartial).toBe(false);
  });
});

describe("nextStep", () => {
  const next = { slot: "meal-2" as const, label: "Meal 2", name: "Oats", time: "12:30", kcal: 400, protein: 30, image: null };

  it("names one plain step for today, from what the face already shows", () => {
    expect(nextStep({ when: "today", planned: 3, next, water: { cups: 2, goal: 8 } })).toBe("Tick each meal once you've had it.");
    expect(nextStep({ when: "today", planned: 3, next, water: { cups: 0, goal: 8 } })).toBe("No water yet today. Tap the cup to log some.");
    expect(nextStep({ when: "today", planned: 3, next: null })).toBe("Every meal is in. Mark the day fully logged when you're done.");
  });

  it("never reads unread water as none", () => {
    expect(nextStep({ when: "today", planned: 3, next })).toBe("Tick each meal once you've had it.");
    expect(nextStep({ when: "today", planned: 3, next, water: { cups: 0, goal: 0 } })).toBe("Tick each meal once you've had it.");
  });

  it("speaks to a past day, a future day and a day with nothing planned", () => {
    expect(nextStep({ when: "past", planned: 3, next })).toBe("Tick the meals you had so this day counts.");
    expect(nextStep({ when: "past", planned: 3, next: null })).toBe("Mark this day fully logged if nothing else went in.");
    expect(nextStep({ when: "future", planned: 3, next })).toBe("Coming up. Tap a meal below to change it.");
    expect(nextStep({ when: "future", planned: 0, next: null })).toBe("Nothing is planned for this day yet.");
    expect(nextStep({ when: "today", planned: 0, next: null })).toBe("Nothing is planned. Tap + to log what you have.");
  });

  it("never tells anyone to eat", () => {
    const lines = (["today", "past", "future"] as const).flatMap((when) => [0, 3].flatMap((planned) =>
      [next, null].map((n) => nextStep({ when, planned, next: n, water: { cups: 0, goal: 8 } }))));
    for (const line of lines) expect(line).not.toMatch(/\beat\b|\beat more\b|should/i);
  });
});

describe("dayHeading", () => {
  it("names today, yesterday and tomorrow, and other days by weekday", () => {
    expect(dayHeading("2026-10-01", "2026-10-01")).toEqual({ title: "Today", subtitle: "Thursday 1 October", short: "Thu 1 Oct" });
    expect(dayHeading("2026-09-30", "2026-10-01")).toEqual({ title: "Yesterday", subtitle: "Wednesday 30 September", short: "Wed 30 Sep" });
    expect(dayHeading("2026-10-02", "2026-10-01")).toEqual({ title: "Tomorrow", subtitle: "Friday 2 October", short: "Fri 2 Oct" });
    expect(dayHeading("2026-10-05", "2026-10-01")).toEqual({ title: "Monday", subtitle: "5 October", short: "5 Oct" });
  });

  it("adds the year only outside the current one", () => {
    expect(dayHeading("2027-01-04", "2026-10-01").subtitle).toBe("4 January 2027");
  });
});
