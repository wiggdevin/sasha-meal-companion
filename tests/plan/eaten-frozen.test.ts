/**
 * An eaten slot with nothing saved to describe it (an old timestamp-only tick, or a tick on a slot
 * that showed no meal) is frozen, and a log filed under it is its record (2026-10-04 audit,
 * BLOCKER 1 and MAJOR 2). One rule, the same on the card, in the day's total and in every other
 * slot's share:
 *   - with a log under the slot: the card counts 0, the log counts once, the slot leaves the pool;
 *   - without one: the card is an estimate at the frozen even share, and the slot leaves the pool.
 * So a skip or a log elsewhere can never rewrite a meal already eaten.
 */
import { describe, expect, it } from "vitest";
import { SLOT_LABELS } from "@/lib/meals";
import { defaultStore } from "@/lib/store";
import { frozenEatenShare, plannedSlotIds, resolveDay, scaledSlotTarget } from "@/lib/resolve";
import { previewSkip } from "@/lib/plan/skip-preview";
import { EATEN_LOGGED_NAME } from "@/lib/plan/eaten-estimate";
import { clearMeal } from "@/lib/today/meal-actions";
import type { FoodComponent, LoggedFood, Macros, SlotId, SlotOverride, Store } from "@/lib/types";

const DATE = "2026-10-04";
const DAY: Macros = { kcal: 1800, protein: 135, carbs: 180, fat: 60 };

function account(meals = 3): Store {
  const store = defaultStore();
  store.settings = { ...store.settings, trainingWeekdays: [], mealsPerDay: meals, ruleReviewReady: true,
    activeTargetProfile: { revision: 1, training: DAY, rest: DAY,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  return store;
}

function log(id: string, kcal: number, slot?: LoggedFood["slot"]): LoggedFood {
  return { id, foodId: "f", name: "Pasta", portionLabel: "1 plate", qty: 1, grams: 300,
    macros: { kcal, protein: kcal / 20, carbs: kcal / 8, fat: kcal / 45 }, at: `${DATE}T13:00:00Z`,
    ...(slot ? { slot } : {}) };
}

const kcalOf = (store: Store, slot: SlotId) => scaledSlotTarget(store, DATE, "rest", slot)?.kcal;
const card = (store: Store, slot: SlotId) => resolveDay(store, DATE).slots.find((s) => s.slot === slot)!;

describe("a log on an eaten slot with nothing saved (audit BLOCKER 1)", () => {
  // The audit's day: 1800 kcal, three meals, Meal 2 eaten with nothing saved, 700 kcal logged to it.
  function auditDay(): Store {
    const store = account();
    expect(plannedSlotIds(store, DATE, "rest")).toEqual(["meal-1", "meal-2", "meal-3"]);
    store.days[DATE] = { date: DATE, eaten: { "meal-2": `${DATE}T12:30:00Z` },
      extras: [log("lunch", 700, "meal-2")] };
    return store;
  }

  it("counts the log once and takes the slot out of the open pool", () => {
    const store = auditDay();
    const lunch = card(store, "meal-2");
    expect(lunch.meal?.name).toBe(EATEN_LOGGED_NAME);
    expect(lunch.eaten).toBe(true);
    expect(lunch.macros.kcal).toBe(0);
    // The other meals shrink by the 700 and split what is left two ways, not three.
    expect(kcalOf(store, "meal-1")).toBeCloseTo(550, 5);
    expect(kcalOf(store, "meal-3")).toBeCloseTo(550, 5);
    expect(scaledSlotTarget(store, DATE, "rest", "meal-2")).toBeUndefined();
    expect(frozenEatenShare(store, DATE, "rest", "meal-2")).toBeUndefined();
    const day = resolveDay(store, DATE);
    expect(day.consumed.kcal).toBe(700);
    // Eaten + open shares is the day's target: nothing dropped, nothing counted twice.
    expect(day.consumed.kcal + kcalOf(store, "meal-1")! + kcalOf(store, "meal-3")!).toBeCloseTo(DAY.kcal, 5);
  });

  it("matches the Plan panel's own log-a-slot shape exactly", () => {
    const viaPanel = account();
    viaPanel.days[DATE] = { date: DATE, eaten: { "meal-2": `${DATE}T12:30:00Z` },
      itemOverrides: { "meal-2": { baseMealId: null, title: EATEN_LOGGED_NAME, components: [] } },
      extras: [log("lunch", 700, "meal-2")] };
    const legacy = auditDay();
    for (const slot of ["meal-1", "meal-3"] as const) expect(kcalOf(legacy, slot)).toBeCloseTo(kcalOf(viaPanel, slot)!, 9);
    expect(resolveDay(legacy, DATE).consumed).toEqual(resolveDay(viaPanel, DATE).consumed);
  });
});

describe("an eaten slot with nothing saved and no log (audit MAJOR 2)", () => {
  function eatenDinner(): Store {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { "meal-3": `${DATE}T19:00:00Z` } };
    return store;
  }

  it("is frozen at the even share whatever else happens that day", () => {
    const store = eatenDinner();
    expect(card(store, "meal-3").macros.kcal).toBeCloseTo(600, 5);
    // Skip lunch, log a snack, save a big breakfast: dinner does not move.
    const day = store.days[DATE]!;
    day.itemOverrides = { "meal-2": clearMeal(undefined, null),
      "meal-1": { baseMealId: null, components: [{ name: "Big breakfast", qty: 1, unit: "whole",
        role: "free", macros: { kcal: 1100, protein: 50, carbs: 120, fat: 45 } } as FoodComponent] } };
    day.extras = [log("snack", 300, "snack")];
    expect(card(store, "meal-3").macros.kcal).toBeCloseTo(600, 5);
    expect(frozenEatenShare(store, DATE, "rest", "meal-3")?.kcal).toBeCloseTo(600, 5);
  });

  it("is not absorbed into by a skip: the open meals take the whole freed share", () => {
    const store = eatenDinner();
    const preview = previewSkip(store, DATE, "meal-1");
    if (!preview.ok) throw new Error(preview.reason);
    const dinner = preview.rows.find((row) => row.slot === "meal-3")!;
    expect(dinner).toMatchObject({ state: "eaten", kcalBefore: 600, kcalAfter: 600 });
    expect(preview.absorbedBy).toEqual([SLOT_LABELS["meal-2"]]);
    const lunch = preview.rows.find((row) => row.slot === "meal-2")!;
    expect(lunch.kcalAfter - lunch.kcalBefore).toBe(preview.freedKcal);
  });
});

/** mulberry32: a small seeded generator, so a failing case can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDay(seed: number): { store: Store; slots: SlotId[] } {
  const next = rng(seed);
  const store = account(2 + Math.floor(next() * 5));
  const slots = plannedSlotIds(store, DATE, "rest");
  const itemOverrides: Partial<Record<SlotId, SlotOverride>> = {};
  const eaten: Partial<Record<SlotId, string>> = {};
  for (const slot of slots) {
    const roll = next();
    if (roll < 0.25) {
      itemOverrides[slot] = { baseMealId: null, components: [{ name: "Saved", qty: 1, unit: "whole",
        role: "free", macros: { kcal: 100 + next() * 500, protein: 20, carbs: 30, fat: 8 } } as FoodComponent] };
    } else if (roll < 0.35) itemOverrides[slot] = clearMeal(undefined, null);
    if (next() < 0.4) eaten[slot] = `${DATE}T12:00:00Z`;
  }
  const extras = Array.from({ length: Math.floor(next() * 4) }, (_, i) => log(`e${i}`, 50 + next() * 400,
    next() < 0.6 ? slots[Math.floor(next() * slots.length)] : next() < 0.5 ? "snack" : undefined));
  store.days[DATE] = { date: DATE, itemOverrides, eaten, extras };
  return { store, slots };
}

describe("property: random days with eaten marks and logs", () => {
  it("cards, the day's total and the open shares add up to the target, each log counted once", () => {
    let checked = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const { store, slots } = randomDay(seed);
      const day = resolveDay(store, DATE);
      const open = slots.map((slot) => kcalOf(store, slot)).filter((v): v is number => v !== undefined);
      // Saved (or skipped) meals not eaten are fixed too: the only fixed spend outside consumed.
      const savedUneaten = day.slots.filter((slot) => !slot.eaten && kcalOf(store, slot.slot) === undefined)
        .reduce((sum, slot) => sum + slot.macros.kcal, 0);
      const logs = (store.days[DATE]!.extras ?? []).reduce((sum, entry) => sum + entry.macros.kcal, 0);
      const eatenCards = day.slots.filter((slot) => slot.eaten).reduce((sum, slot) => sum + slot.macros.kcal, 0);
      // Every log counts once in the day's total, beside the eaten cards.
      expect(day.consumed.kcal).toBe(Math.round(eatenCards + logs));
      const spent = eatenCards + logs + savedUneaten;
      if (open.length === 0 || spent >= DAY.kcal) continue;
      expect(spent + open.reduce((a, b) => a + b, 0)).toBeCloseTo(DAY.kcal, 6);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("an eaten slot's card never moves when another slot is skipped or logged to", () => {
    let checked = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const { store, slots } = randomDay(seed);
      const stored = store.days[DATE]!;
      const eaten = slots.filter((slot) => stored.eaten?.[slot]);
      const other = slots.find((slot) => !stored.eaten?.[slot]);
      if (!eaten.length || !other) continue;
      const before = eaten.map((slot) => card(store, slot).macros);
      stored.itemOverrides = { ...stored.itemOverrides, [other]: clearMeal(undefined, null) };
      stored.extras = [...(stored.extras ?? []), log("late", 640, other)];
      expect(eaten.map((slot) => card(store, slot).macros)).toEqual(before);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(150);
  });
});
