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

const { APP_TIPS, boardTips, isNewAccount, nextMeal, orderTips, tipIndexFor, weekSummary } = await import("@/lib/today/board");
type TipContext = import("@/lib/today/board").TipContext;
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

describe("tips", () => {
  it("puts the coach's tips first and never repeats one", () => {
    const tips = boardTips([{ id: "coach-1", source: "coach", text: "From the coach." }, APP_TIPS[0]]);
    expect(tips[0].id).toBe("coach-1");
    expect(new Set(tips.map((tip) => tip.id)).size).toBe(tips.length);
  });

  it("rotates once a day", () => {
    expect(tipIndexFor("2026-10-01", 6)).toBe(1);
    expect(tipIndexFor("2026-10-06", 6)).toBe(0);
    expect(tipIndexFor("2026-10-06", 0)).toBe(0);
  });

  it("gives every app tip a glyph, a headline, a line, full steps and a demonstration", () => {
    for (const tip of APP_TIPS) {
      expect(tip.title.length).toBeGreaterThan(0);
      expect(tip.text.length).toBeGreaterThan(0);
      expect(tip.steps.length).toBeGreaterThanOrEqual(3);
      expect(tip.glyph).toBeTruthy();
      expect(tip.demo).toBeTruthy();
    }
    expect(new Set(APP_TIPS.map((tip) => tip.demo)).size).toBe(APP_TIPS.length);
  });
});

describe("orderTips", () => {
  // An old account on a rest day with water logged and every meal ticked: nothing is pressing.
  const calm: TipContext = { date: "2026-10-06", today: "2026-10-06", water: { cups: 4, goal: 8 }, planned: 3,
    open: false, firstOpenedAt: "2026-08-01T09:00:00Z", training: false };
  const ids = (context: Partial<TipContext>, tips = boardTips()) => orderTips(tips, { ...calm, ...context }).map((tip) => tip.id);
  const base = APP_TIPS.map((tip) => tip.id);

  it("falls back to the list order, starting from the day's tip, and is stable", () => {
    expect(ids({})).toEqual(base);
    expect(ids({ date: "2026-10-01" })).toEqual([...base.slice(1), base[0]]);
    expect(ids({ date: "2026-10-01" })).toEqual(ids({ date: "2026-10-01" }));
  });

  it("puts the water tip first when no water is logged today, and only today", () => {
    expect(ids({ water: { cups: 0, goal: 8 } })[0]).toBe("water");
    // On a past day the water rests; the day's tip leads.
    expect(ids({ water: { cups: 0, goal: 8 }, date: "2026-10-04" })[0]).toBe(base[4]);
    // Water not read yet is not "none logged".
    expect(ids({ water: null })[0]).toBe(base[0]);
  });

  it("leads with clearing a past day's unticked meals", () => {
    expect(ids({ date: "2026-10-04", open: true })[0]).toBe("swipe");
    expect(ids({ open: true })[0]).not.toBe("swipe");
  });

  it("walks a new account through the orb, the week and the month first", () => {
    expect(ids({ firstOpenedAt: "2026-10-03T08:00:00Z" }).slice(0, 3)).toEqual(["orb", "scrub", "month"]);
    expect(isNewAccount({ firstOpenedAt: "2026-09-30", today: "2026-10-06" })).toBe(true);
    expect(isNewAccount({ firstOpenedAt: "2026-09-29", today: "2026-10-06" })).toBe(false);
    expect(isNewAccount({ firstOpenedAt: "not a date", today: "2026-10-06" })).toBe(false);
    expect(isNewAccount({ firstOpenedAt: null, today: "2026-10-06" })).toBe(false);
  });

  it("brings moving a meal's time forward on a training day with meals still open", () => {
    expect(ids({ training: true, open: true })[0]).toBe("time");
    expect(ids({ training: true, open: false })[0]).toBe(base[0]);
  });

  it("orders several pressing tips by how pressing they are, then by the list", () => {
    const order = ids({ water: { cups: 0, goal: 8 }, firstOpenedAt: "2026-10-06", training: true, open: true });
    expect(order.slice(0, 5)).toEqual(["water", "orb", "time", "scrub", "month"]);
    expect(new Set(order).size).toBe(APP_TIPS.length);
  });

  it("keeps the coach's tips ahead of the app's resting ones, behind anything pressing", () => {
    const coach = [{ id: "coach-1", source: "coach" as const, text: "From the coach." }];
    expect(ids({}, boardTips(coach))[0]).toBe("coach-1");
    expect(ids({ water: { cups: 0, goal: 8 } }, boardTips(coach)).slice(0, 2)).toEqual(["water", "coach-1"]);
    const urgent = [{ ...coach[0], relevance: () => 9 }];
    expect(ids({ water: { cups: 0, goal: 8 } }, boardTips(urgent))[0]).toBe("coach-1");
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
