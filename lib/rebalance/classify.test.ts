/** Phase 19 §5.3 / §7: the classifier, run on days resolved through the real resolveDay. */
import { describe, expect, it } from "vitest";
import { withAcceptedRecipeSelections } from "@/lib/recipes/accepted-overlay";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import { isoDaysBefore } from "@/lib/settings/date";
import { targetDayFor } from "@/lib/targets/revision";
import type { StoredDay, Store } from "@/lib/types";
import {
  account, at, build, DATE, eatenAt, entry, item, saved,
} from "./__fixtures__/days";
import { dayBalance, panelNow, type DayBalance } from "./balance";
import { classifyDay } from "./classify";
import type { PanelNow } from "./missed";

function run(stored: Omit<StoredDay, "date">, now: PanelNow = at("12:00"), store: Store = account()) {
  store.days[DATE] = { date: DATE, ...stored };
  const { day, slots } = build(store);
  const balance = dayBalance(day, slots, now);
  return { day, balance, panel: classifyDay(DATE, now.date, balance) };
}

/** Meal 1 eaten (500), Meal 2 planned (600) and missed after 14:00, Meal 3 planned at `dinner`. */
function plannedDay(dinner: number, time = "18:30"): Omit<StoredDay, "date"> {
  return { eaten: eatenAt("meal-1"), itemOverrides: { "meal-1": saved(500, "Oats"),
    "meal-2": saved(600, "Lunch"), "meal-3": saved(dinner, "Dinner", { time }) } };
}

describe("incomplete intake", () => {
  it("Unknown energy: a logged item with protein and no energy", () => {
    const { balance, panel } = run({ extras: [entry("shake", [item()])] });
    expect(panel.state).toBe("incomplete_intake");
    expect(balance.intake).toMatchObject({ recordedKcal: 0, unknownItems: 1, status: "incomplete" });
    expect(balance.left).toBeNull();
    expect(balance.planned).toBeNull();
  });

  it("Empty snapshot: the reconcile placeholder", () => {
    const placeholder = { ...item(), snapshot: {} };
    const { balance, panel } = run({ extras: [entry("p", [placeholder])] });
    expect(balance.intake.unknownItems).toBe(1);
    expect(panel.state).toBe("incomplete_intake");
  });

  it("Partial recipe: a 200 kcal partly measured serving", () => {
    const { balance, panel } = run({ extras: [entry("r", [item({ reported: 200 })], "meal-1",
      { nutritionPartial: true })] });
    expect(panel.state).toBe("incomplete_intake");
    expect(balance.intake).toMatchObject({ status: "incomplete", partial: true, recordedKcal: 200 });
    expect(balance.left).toBeNull();
    expect(balance.planned).toBeNull();
  });

  it("highlights missed cards and takes an estimated day with no cards before no_action", () => {
    const missed = run({ extras: [entry("shake", [item()], "snack")] }, at("14:00"));
    expect(missed.panel).toEqual({ state: "incomplete_intake", highlights: ["meal-1", "meal-2"] });
    const estimated = run({ eaten: { ...eatenAt("meal-1"), ...eatenAt("meal-2"), ...eatenAt("meal-3") } },
      at("21:45"));
    expect(estimated.balance.intake.status).toBe("estimated");
    expect(estimated.balance.remaining).toEqual([]);
    expect(estimated.panel).toEqual({ state: "incomplete_intake", highlights: [] });
  });
});

describe("Accepted recipe", () => {
  it("is a remaining 700 kcal card that counts in planned", () => {
    const selection: AcceptedRecipeSelection = {
      id: "selection", localDate: DATE, slotId: "meal-3", recipeId: "recipe",
      recipeRevisionId: "revision", recipeName: "Stew", servingFraction: 1, ingredientSnapshot: [],
      nutritionSnapshot: Object.fromEntries(Object.entries({ kcal: 700, protein: 40, carbs: 70, fat: 25 })
        .map(([key, value]) => [key, { value, status: "estimated", sourceRevisionId: null }])),
      exactFitAvailable: false, approximateFitAvailable: true, evidenceIssues: [], planRevision: 1,
    };
    const store = account();
    store.days[DATE] = { date: DATE, eaten: eatenAt("meal-1"), itemOverrides: { "meal-1": saved(500, "Oats") } };
    const projected = withAcceptedRecipeSelections(store, [selection]);
    const { day, slots } = build(projected);
    const balance = dayBalance(day, slots, at("13:00"));
    const stew = balance.remaining.find((slot) => slot.slot === "meal-3");
    expect(stew?.meal?.name).toBe("Stew");
    expect(stew?.macros.kcal).toBe(700);
    expect(balance.planned).toBe(500 + 700);
    expect(classifyDay(DATE, DATE, balance).state).toBe("under");
  });
});

describe("Date first", () => {
  const now = new Date(2026, 9, 6, 23, 50); // local 23:50, which is already 7 October in UTC east of here
  const today = targetDayFor(now);

  it("hides yesterday even with no target, and tomorrow with one", () => {
    expect(today).toBe("2026-10-06");
    const yesterday = isoDaysBefore(today, 1);
    const none = account(null);
    const { day, slots } = build(none, yesterday);
    expect(classifyDay(yesterday, today, dayBalance(day, slots, panelNow(now))).state).toBe("hidden");
    expect(classifyDay(yesterday, today, null).state).toBe("hidden");
    const store = account();
    const tomorrow = build(store, "2026-10-07");
    expect(classifyDay("2026-10-07", today, dayBalance(tomorrow.day, tomorrow.slots, panelNow(now))))
      .toEqual({ state: "hidden", highlights: [] });
  });

  it("uses the device's local date near midnight", () => {
    expect(panelNow(now).date).toBe(today);
    expect(classifyDay("2026-10-06", panelNow(now).date, null).state).toBe("no_target");
    expect(classifyDay("2026-10-07", panelNow(now).date, null).state).toBe("hidden");
  });
});

describe("Classifier rows", () => {
  it("no_target: no revision, or no balance", () => {
    expect(run({}, at("12:00"), account(null)).panel).toEqual({ state: "no_target", highlights: [] });
    expect(classifyDay(DATE, DATE, null)).toEqual({ state: "no_target", highlights: [] });
  });

  it("spent: T 1,800, 2,000 recorded, every meal eaten, at 12:00 and at 21:45", () => {
    const store = () => account(1800);
    const day: Omit<StoredDay, "date"> = {
      eaten: { ...eatenAt("meal-1"), ...eatenAt("meal-2"), ...eatenAt("meal-3") },
      itemOverrides: { "meal-1": saved(600, "A"), "meal-2": saved(700, "B"), "meal-3": saved(700, "C") },
    };
    for (const clock of ["12:00", "21:45"]) {
      const { balance, panel } = run(day, at(clock), store());
      expect(balance.intake).toMatchObject({ recordedKcal: 2000, status: "complete" });
      expect(panel).toEqual({ state: "spent", highlights: [] });
    }
  });

  it("spent at T + tol + 1, highlighting remaining cards; not at T + tol", () => {
    const over = run({ eaten: eatenAt("meal-1"), itemOverrides: { "meal-1": saved(2101, "Feast"),
      "meal-3": saved(400, "Dinner") } }, at("10:00"));
    expect(over.panel).toEqual({ state: "spent", highlights: ["meal-2", "meal-3"] });
    const edge = run({ eaten: eatenAt("meal-1"), itemOverrides: { "meal-1": saved(2100, "Feast") } },
      at("10:00"));
    expect(edge.panel.state).not.toBe("spent");
  });

  it("no_action: no cards and intake within", () => {
    const { panel } = run({ eaten: { ...eatenAt("meal-1"), ...eatenAt("meal-2"), ...eatenAt("meal-3") },
      itemOverrides: { "meal-1": saved(600, "A"), "meal-2": saved(700, "B"), "meal-3": saved(700, "C") } },
    at("19:00"));
    expect(panel).toEqual({ state: "no_action", highlights: [] });
  });

  it("no_action once fewer than 30 minutes remain before the eating end", () => {
    const at30 = run(plannedDay(1400, "22:00"), at("21:30"));
    expect(at30.balance.windowMinutes).toBe(30);
    expect(at30.panel.state).not.toBe("no_action");
    const at29 = run(plannedDay(1400, "22:00"), at("21:31"));
    expect(at29.balance.windowMinutes).toBe(29);
    expect(at29.panel).toEqual({ state: "no_action", highlights: [] });
  });

  it("over at planned T + tol + 1, highlighting remaining; on_track at T + tol", () => {
    const over = run(plannedDay(1601), at("14:00"));
    expect(over.balance.planned).toBe(2101);
    expect(over.panel).toEqual({ state: "over", highlights: ["meal-3"] });
    const edge = run(plannedDay(1600), at("14:00"));
    expect(edge.balance.planned).toBe(2100);
    expect(edge.panel).toEqual({ state: "on_track", highlights: ["meal-2"] });
  });

  it("under at planned T − tol − 1, missed cards first; on_track at T − tol", () => {
    const under = run(plannedDay(1399), at("14:00"));
    expect(under.balance.planned).toBe(1899);
    expect(under.panel).toEqual({ state: "under", highlights: ["meal-2", "meal-3"] });
    const edge = run(plannedDay(1400), at("14:00"));
    expect(edge.panel).toEqual({ state: "on_track", highlights: ["meal-2"] });
  });

  it("on_track with nothing missed highlights nothing", () => {
    const { balance, panel } = run(plannedDay(900), at("13:00"));
    expect(balance.planned).toBe(2000);
    expect(panel).toEqual({ state: "on_track", highlights: [] });
  });

  it("reads the day as a whole, not the balance alone (hand-built balance)", () => {
    const balance: DayBalance = { targetKcal: 2000, missed: [], remaining: [], eatingEndMinutes: 1290,
      windowMinutes: 600, left: 2000, planned: 0,
      intake: { recordedKcal: 0, status: "complete", estimatedSlots: 0, unknownSlots: 0,
        unknownItems: 0, unknownEntries: 0, partial: false } };
    expect(classifyDay(DATE, DATE, balance).state).toBe("no_action");
  });
});
