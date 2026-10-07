/**
 * How the day's target splits across its open meals (lib/plan/slot-share.ts): logged food outside
 * the slots shrinks the open shares, a cleared (skipped) meal gives its share away, and a slot that
 * holds a saved meal still gets a planning target (the owner's empty-Meal-1 report, 2026-10-03).
 */
import { describe, expect, it } from "vitest";
import { defaultStore } from "@/lib/store";
import { planningSlotTarget, plannedSlotIds, resolveDay, scaledSlotTarget } from "@/lib/resolve";
import { EATEN_LOGGED_NAME } from "@/lib/plan/eaten-estimate";
import { clearMeal } from "@/lib/today/meal-actions";
import type { FoodComponent, LoggedFood, Macros, SlotId, Store } from "@/lib/types";

const DATE = "2026-10-03";
const DAY: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 66 };

function account(): Store {
  const store = defaultStore();
  store.settings = { ...store.settings, trainingWeekdays: [], ruleReviewReady: true,
    activeTargetProfile: { revision: 1, training: DAY, rest: DAY,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  return store;
}

const slotsOf = (store: Store) => plannedSlotIds(store, DATE, "rest");
const kcal = (store: Store, slot: SlotId) => scaledSlotTarget(store, DATE, "rest", slot)?.kcal;

function log(id: string, kcalValue: number, slot?: LoggedFood["slot"]): LoggedFood {
  return { id, foodId: "f", name: "Gummy worms", portionLabel: "1 handful", qty: 1, grams: 40,
    macros: { kcal: kcalValue, protein: 0, carbs: kcalValue / 4, fat: 0 }, at: `${DATE}T20:00:00Z`,
    ...(slot ? { slot } : {}) };
}

const shake: FoodComponent = { name: "whey protein powder", qty: 62, unit: "g", role: "free",
  macros: { kcal: 544, protein: 55, carbs: 33, fat: 21 } } as FoodComponent;

describe("logged extras", () => {
  it("shrink every open meal's share so the cards agree with what is left", () => {
    const store = account();
    const slots = slotsOf(store);
    const even = DAY.kcal / slots.length;
    expect(kcal(store, slots[0])).toBeCloseTo(even, 5);
    store.days[DATE] = { date: DATE, extras: [log("e1", 160), log("e2", 40, "snack")] };
    for (const slot of slots) expect(kcal(store, slot)).toBeCloseTo((DAY.kcal - 200) / slots.length, 5);
    const day = resolveDay(store, DATE);
    const open = slots.reduce((sum, slot) => sum + (kcal(store, slot) ?? 0), 0);
    expect(open).toBeCloseTo(day.targets!.kcal - day.consumed.kcal, 0);
  });

  it("are filed under a slot and still count when that slot is open", () => {
    const store = account();
    const slots = slotsOf(store);
    store.days[DATE] = { date: DATE, extras: [log("e1", 300, slots[1])] };
    expect(kcal(store, slots[0])).toBeCloseTo((DAY.kcal - 300) / slots.length, 5);
  });

  it("count once when the log stands for an eaten meal with nothing saved", () => {
    const store = account();
    const slots = slotsOf(store);
    store.days[DATE] = { date: DATE, eaten: { [slots[0]]: `${DATE}T08:00:00Z` },
      extras: [log("e1", 450, slots[0])] };
    // The log is that meal's record: the eaten slot is fixed at zero and leaves the open pool, and
    // the log is paid once, so the other slots split what is left (2026-10-04 audit, BLOCKER 1).
    expect(kcal(store, slots[0])).toBeUndefined();
    expect(kcal(store, slots[1])).toBeCloseTo((DAY.kcal - 450) / (slots.length - 1), 5);
    const day = resolveDay(store, DATE);
    expect(day.slots.find((slot) => slot.slot === slots[0])!.macros.kcal).toBe(0);
    expect(day.consumed.kcal).toBe(450);
  });

  it("count once when the Plan panel logged a slot and emptied its card", () => {
    const store = account();
    const slots = slotsOf(store);
    store.days[DATE] = { date: DATE, eaten: { [slots[0]]: `${DATE}T08:00:00Z` },
      itemOverrides: { [slots[0]]: { baseMealId: null, title: EATEN_LOGGED_NAME, components: [] } },
      extras: [log("e1", 450, slots[0])] };
    // That slot is fixed at zero and the log is the one record of it.
    expect(kcal(store, slots[1])).toBeCloseTo((DAY.kcal - 450) / (slots.length - 1), 5);
  });

  it("never push a share below zero", () => {
    const store = account();
    store.days[DATE] = { date: DATE, extras: [log("e1", 5000)] };
    expect(kcal(store, slotsOf(store)[0])).toBe(0);
  });
});

describe("a skipped (cleared) meal", () => {
  it("gives its share to the other open meals", () => {
    const store = account();
    const slots = slotsOf(store);
    const last = slots.at(-1)!;
    store.days[DATE] = { date: DATE, itemOverrides: { [last]: clearMeal(undefined, null) } };
    expect(kcal(store, last)).toBeUndefined();
    expect(kcal(store, slots[0])).toBeCloseTo(DAY.kcal / (slots.length - 1), 5);
  });
});

describe("the planning target", () => {
  it("is defined for a slot that holds a saved meal, and counts that slot as open", () => {
    const store = account();
    const slots = slotsOf(store);
    store.days[DATE] = { date: DATE,
      itemOverrides: { [slots[0]]: { baseMealId: null, title: "Whey protein shake", components: [shake] } } };
    // The saved meal is fixed for Today's other cards...
    expect(kcal(store, slots[0])).toBeUndefined();
    expect(kcal(store, slots[1])).toBeCloseTo((DAY.kcal - 544) / (slots.length - 1), 5);
    // ...but planning it again gets an even share instead of "targets will appear" copy.
    expect(planningSlotTarget(store, DATE, "rest", slots[0])?.kcal)
      .toBeCloseTo(DAY.kcal / slots.length, 5);
  });

  it("stays absent for an eaten slot", () => {
    const store = account();
    const slots = slotsOf(store);
    store.days[DATE] = { date: DATE, eaten: { [slots[0]]: `${DATE}T08:00:00Z` } };
    expect(planningSlotTarget(store, DATE, "rest", slots[0])).toBeUndefined();
  });

  it("is absent only when the account has no target revision", () => {
    const store = account();
    store.settings = { ...store.settings, activeTargetProfile: undefined } as Store["settings"];
    expect(planningSlotTarget(store, DATE, "rest", slotsOf(store)[0])).toBeUndefined();
  });
});
