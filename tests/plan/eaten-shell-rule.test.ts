/**
 * 2026-10-04 re-audit (Grok, plan slice):
 *   MAJOR 1: an eaten slot is "undescribed" (frozen estimate) only when its override is absent or
 *     a followPlan override with no food — the shell rule resolveDay uses. A followPlan override
 *     that holds food is shown and counted as that food, on the card, in the day's total and in
 *     every other slot's share.
 *   MAJOR 2: once the Plan panel files a log as a slot's record (the "counted in your log" shell),
 *     an eaten recipe snapshot on that slot no longer counts anywhere, and countLogOnce writes the
 *     shell even when the slot was already ticked.
 */
import { describe, expect, it, vi } from "vitest";
import { defaultStore } from "@/lib/store";
import { frozenEatenShare, resolveDay, scaledSlotTarget } from "@/lib/resolve";
import {
  EATEN_ESTIMATE_NAME, EATEN_LOGGED_NAME, undescribedEatenSlots,
} from "@/lib/plan/eaten-estimate";
import { authoritativeSlotTarget } from "@/lib/recipes/slot-target";
import { countLogOnce } from "@/lib/today/count-log-once";
import type { ConsumedRecipeSnapshot, FoodComponent, LoggedFood, Macros, SlotId, SlotOverride, Store } from "@/lib/types";

const DATE = "2026-10-04";
const DAY: Macros = { kcal: 1800, protein: 135, carbs: 180, fat: 60 };

function account(): Store {
  const store = defaultStore();
  store.settings = { ...store.settings, trainingWeekdays: [], mealsPerDay: 3, ruleReviewReady: true,
    activeTargetProfile: { revision: 1, training: DAY, rest: DAY,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  return store;
}

function food(name: string, kcal: number): FoodComponent {
  return { name, qty: 1, unit: "whole", role: "free",
    macros: { kcal, protein: kcal / 20, carbs: kcal / 10, fat: kcal / 45 } } as FoodComponent;
}

function log(id: string, kcal: number, slot?: LoggedFood["slot"]): LoggedFood {
  return { id, foodId: "f", name: "Plate", portionLabel: "1 plate", qty: 1, grams: 300,
    macros: { kcal, protein: kcal / 20, carbs: kcal / 8, fat: kcal / 45 }, at: `${DATE}T19:00:00Z`,
    ...(slot ? { slot } : {}) };
}

const kcalOf = (store: Store, slot: SlotId) => scaledSlotTarget(store, DATE, "rest", slot)?.kcal;
const card = (store: Store, slot: SlotId) => resolveDay(store, DATE).slots.find((s) => s.slot === slot)!;

describe("an eaten followPlan override that holds food (re-audit MAJOR 1)", () => {
  function timedDinner(components: FoodComponent[]): Store {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { "meal-3": `${DATE}T19:30:00Z` },
      itemOverrides: { "meal-3": { baseMealId: "plan-dinner", components, followPlan: true, time: "19:30" } } };
    return store;
  }

  it("shows and counts the saved foods, not an estimate", () => {
    const store = timedDinner([food("Salmon", 450), food("Rice", 250)]);
    expect(undescribedEatenSlots(store.days[DATE], ["meal-3"]).size).toBe(0);
    const dinner = card(store, "meal-3");
    expect(dinner.meal?.name).not.toBe(EATEN_ESTIMATE_NAME);
    expect(dinner.components.map((c) => c.name)).toEqual(["Salmon", "Rice"]);
    expect(dinner.macros.kcal).toBe(700);
    expect(resolveDay(store, DATE).consumed.kcal).toBe(700);
    expect(frozenEatenShare(store, DATE, "rest", "meal-3")).toBeUndefined();
    // The other two meals share what the saved foods leave: (1800 - 700) / 2.
    expect(kcalOf(store, "meal-1")).toBeCloseTo(550, 6);
    expect(kcalOf(store, "meal-2")).toBeCloseTo(550, 6);
  });

  it("keeps the food-less followPlan shell an estimate at the frozen share", () => {
    const store = timedDinner([]);
    expect(undescribedEatenSlots(store.days[DATE], ["meal-3"])).toEqual(new Set(["meal-3"]));
    expect(card(store, "meal-3").meal?.name).toBe(EATEN_ESTIMATE_NAME);
    expect(card(store, "meal-3").macros.kcal).toBeCloseTo(600, 6);
    expect(kcalOf(store, "meal-1")).toBeCloseTo(600, 6);
  });

  it("the card, the total and the shares agree on random followPlan days", () => {
    for (let n = 0; n < 60; n += 1) {
      const parts = Array.from({ length: n % 4 }, (_, i) => food(`F${i}`, 80 + ((n * 37 + i * 53) % 400)));
      const store = timedDinner(parts);
      const dinner = card(store, "meal-3");
      const open = kcalOf(store, "meal-1")! + kcalOf(store, "meal-2")!;
      expect(resolveDay(store, DATE).consumed.kcal).toBe(Math.round(dinner.macros.kcal));
      expect(dinner.macros.kcal + open).toBeCloseTo(DAY.kcal, 6);
    }
  });
});

describe("a log filed under a followPlan snapshot slot (2026-10-05 audit, MAJOR 4)", () => {
  function timedDinnerWithLog(components: FoodComponent[]): Store {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { "meal-3": `${DATE}T19:30:00Z` },
      itemOverrides: { "meal-3": { baseMealId: "plan-dinner", components, followPlan: true, time: "19:30" } },
      extras: [log("plate", 800, "meal-3")] };
    return store;
  }

  it("counts the log once, not the snapshot plus the log", () => {
    // A time-edit saved Salmon 450 + Rice 250 (700 kcal), then an 800 kcal log was filed under the
    // same slot without the "counted in your log" shell. The log wins: the slot is zero and the
    // snapshot is not shown, so the day does not add 1500 kcal for one meal.
    const store = timedDinnerWithLog([food("Salmon", 450), food("Rice", 250)]);
    const dinner = card(store, "meal-3");
    expect(dinner.components).toEqual([]);
    expect(dinner.macros.kcal).toBe(0);
    expect(resolveDay(store, DATE).consumed.kcal).toBe(800);
    // The other two meals share what the log leaves: (1800 - 800) / 2, not (1800 - 700 - 800) / 2.
    expect(kcalOf(store, "meal-1")).toBeCloseTo(500, 6);
    expect(kcalOf(store, "meal-2")).toBeCloseTo(500, 6);
  });

  it("the card and the day's total agree on random snapshot-plus-log days", () => {
    for (let n = 0; n < 30; n += 1) {
      const parts = Array.from({ length: (n % 4) + 1 }, (_, i) => food(`F${i}`, 80 + ((n * 41 + i * 59) % 400)));
      const store = timedDinnerWithLog(parts);
      const dinner = card(store, "meal-3");
      const open = kcalOf(store, "meal-1")! + kcalOf(store, "meal-2")!;
      expect(dinner.macros.kcal).toBe(0);
      expect(resolveDay(store, DATE).consumed.kcal).toBe(800);
      expect(open).toBeCloseTo(DAY.kcal - 800, 6);
    }
  });
});

describe("a log filed under an eaten recipe (re-audit MAJOR 2)", () => {
  const snapshot: ConsumedRecipeSnapshot = { baseMealId: "recipe:bowl", title: "Burrito bowl",
    components: [food("Bowl", 700)] };
  const shell: SlotOverride = { baseMealId: "recipe:bowl", title: EATEN_LOGGED_NAME, components: [] };

  function eatenRecipe(): Store {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { "meal-3": `${DATE}T19:00:00Z` },
      consumedSlots: { "meal-3": snapshot }, extras: [log("plate", 800, "meal-3")] };
    return store;
  }

  it("writes the empty meal even though the slot is already ticked", async () => {
    const store = eatenRecipe();
    const saveOverride = vi.fn(async (override: SlotOverride) => {
      store.days[DATE]!.itemOverrides = { "meal-3": override };
    });
    const saveEaten = vi.fn(async () => {});
    const outcome = await countLogOnce({ eaten: true, baseMealId: "recipe:bowl" },
      { isCurrent: () => true, saveOverride, saveEaten });
    expect(outcome).toBe("counted");
    expect(saveOverride).toHaveBeenCalledTimes(1);
    expect(saveEaten).not.toHaveBeenCalled();
    // The log is the only record: 800, not 1500.
    const dinner = card(store, "meal-3");
    expect(dinner.meal?.name).toBe(EATEN_LOGGED_NAME);
    expect(dinner.macros.kcal).toBe(0);
    expect(resolveDay(store, DATE).consumed.kcal).toBe(800);
    expect(kcalOf(store, "meal-1")).toBeCloseTo(500, 6);
  });

  it("does nothing when the card already is the empty meal", async () => {
    const saveOverride = vi.fn(async () => {});
    expect(await countLogOnce({ eaten: true, baseMealId: "recipe:bowl", before: shell },
      { isCurrent: () => true, saveOverride, saveEaten: vi.fn(async () => {}) })).toBe("already-eaten");
    expect(saveOverride).not.toHaveBeenCalled();
  });

  it("ignores a snapshot left over when the shell was saved before the tick", () => {
    const store = account();
    // Shell written while consumedSlots was still set, then the slot ticked eaten.
    store.days[DATE] = { date: DATE, consumedSlots: { "meal-3": snapshot },
      itemOverrides: { "meal-3": shell }, extras: [log("plate", 800, "meal-3")] };
    store.days[DATE]!.eaten = { "meal-3": `${DATE}T19:05:00Z` };
    expect(card(store, "meal-3").macros.kcal).toBe(0);
    expect(resolveDay(store, DATE).consumed.kcal).toBe(800);
    expect(kcalOf(store, "meal-1")).toBeCloseTo(500, 6);
  });

  it("the server's recipe target agrees: the snapshot is not reserved beside the log", () => {
    const row = { item_overrides: { "meal-3": shell },
      eaten_slots: { "meal-3": { eaten_at: `${DATE}T19:00:00Z`, consumed: snapshot } } };
    const target = authoritativeSlotTarget({ id: "p1", rev: 1, input_training_weekdays: [],
      training_macros: DAY, rest_macros: DAY }, DATE, 3, "meal-1", row, [log("plate", 800, "meal-3")]);
    expect(target?.kcal).toBeCloseTo(500, 6);
  });
});
