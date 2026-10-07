/**
 * Every macro of a slot target comes out of one remaining pool (lib/plan/slot-share.ts).
 *
 * The owner's report, 2026-10-04: the Plan panel for Meal 1 read "about 111 kcal · 37 g protein".
 * 37 g protein alone is 148 kcal. Reconstructed from production: a rest day (1891 kcal, 195 P,
 * 154 C, 55 F), four meals, Meals 1-3 saved, nothing eaten or logged. Meals 2 and 3 already hold
 * 1669 kcal and 70.7 g fat, 15.7 g over the day's fat. Each macro was subtracted and clamped on
 * its own, so the overspent fat came out of kcal (222 left) but not out of protein (73.1 g left).
 */
import { describe, expect, it } from "vitest";
import { defaultStore } from "@/lib/store";
import {
  frozenEatenShare, loggedOutsideSlots, planningSlotTarget, plannedSlotIds, ratiosFor, scaledSlotTarget,
} from "@/lib/resolve";
import { remainingPool } from "@/lib/plan/slot-share";
import type { FoodComponent, LoggedFood, Macros, SlotId, SlotOverride, Store } from "@/lib/types";

const DATE = "2026-10-04";
const TRAINING: Macros = { kcal: 2059, protein: 195, carbs: 196, fat: 55 };
const REST: Macros = { kcal: 1891, protein: 195, carbs: 154, fat: 55 };

const part = (name: string, qty: number, macros: Macros): FoodComponent =>
  ({ name, qty, unit: "g", role: "free", macros }) as FoodComponent;

const saved = (title: string, components: FoodComponent[]): SlotOverride =>
  ({ baseMealId: null, title, components }) as SlotOverride;

/** plan_days 2026-10-04, item_overrides as stored. */
const OWNER_OVERRIDES: Partial<Record<SlotId, SlotOverride>> = {
  "meal-1": saved("Whey protein shake", [
    part("whey protein powder", 62, { kcal: 218, protein: 48.4, carbs: 3.9, fat: 1 }),
    part("almond butter", 16, { kcal: 106, protein: 3.4, carbs: 3, fat: 8.9 }),
    part("oat milk", 488, { kcal: 220, protein: 3.2, carbs: 26.2, fat: 11.4 }),
  ]),
  "meal-2": saved("Eggs & Jasmine rice", [
    part("Eggs, large", 460, { kcal: 662, protein: 58, carbs: 3.7, fat: 46 }),
    part("Jasmine rice, cooked", 219, { kcal: 278, protein: 5.5, carbs: 62.4, fat: 0.7 }),
  ]),
  "meal-3": saved("Scallops, Sweet potato & Avocado mayo", [
    part("Scallops, cooked", 258, { kcal: 292, protein: 52.9, carbs: 13.7, fat: 2.8 }),
    part("Sweet potato, peeled & cooked", 273, { kcal: 246, protein: 5.5, carbs: 56, fat: 0 }),
    part("Avocado mayo", 27, { kcal: 191, protein: 0, carbs: 0, fat: 21.2 }),
  ]),
};

function owner(): Store {
  const store = defaultStore();
  store.settings = { ...store.settings, trainingWeekdays: [1, 3, 4, 5], mealsPerDay: 4,
    ruleReviewReady: true,
    activeTargetProfile: { revision: 40, training: TRAINING, rest: REST,
      inputs: { trainingWeekdays: [1, 3, 4, 5] },
      pins: { trainingKcal: 2059, restKcal: 1891, proteinG: 195 } } } as Store["settings"];
  store.days[DATE] = { date: DATE, itemOverrides: structuredClone(OWNER_OVERRIDES) };
  return store;
}

const atwater = (m: Macros) => 4 * m.protein + 4 * m.carbs + 9 * m.fat;

function expectConsistent(target: Macros | undefined) {
  expect(target).toBeDefined();
  const t = target!;
  for (const value of [t.kcal, t.protein, t.carbs, t.fat]) expect(value).toBeGreaterThanOrEqual(0);
  expect(t.kcal + 1e-6).toBeGreaterThanOrEqual(atwater(t));
}

describe("the owner's Meal 1 planning target on 2026-10-04", () => {
  it("is a rest day with four meals", () => {
    const store = owner();
    expect(ratiosFor(store, DATE).dayType).toBe("rest");
    expect(ratiosFor(store, DATE).targets).toEqual(REST);
    expect(plannedSlotIds(store, DATE, "rest")).toEqual(["meal-1", "meal-2", "meal-3", "meal-4"]);
  });

  it("shares the 222 kcal left after Meals 2 and 3 with Meal 4, and protein fits inside it", () => {
    const target = planningSlotTarget(owner(), DATE, "rest", "meal-1");
    expectConsistent(target);
    // 1891 - 940 - 729 = 222 kcal for two open meals.
    expect(target!.kcal).toBeCloseTo(111, 5);
    // 73.1 g protein is left by itself, but only 222 kcal remain: 55.5 g fills them, so 27.75 g
    // each, and no room is left for carbs or fat. Before the fix this read 36.55 g (148 kcal).
    expect(target!.protein).toBeCloseTo(27.75, 5);
    expect(target!.carbs).toBe(0);
    expect(target!.fat).toBe(0);
    // Today's Meal 4 card still counts the saved shake (2213 kcal saved in all, over the day's
    // 1891), so it honestly has nothing left, in every macro.
    expect(scaledSlotTarget(owner(), DATE, "rest", "meal-4"))
      .toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });

  it("fits every macro when the saved meals leave room for all of them", () => {
    const store = owner();
    // Without the eggs, only Meal 3 is fixed: 1162 kcal, 136.6 P, 84.3 C, 31 F left for three.
    delete store.days[DATE]!.itemOverrides!["meal-2"];
    const target = planningSlotTarget(store, DATE, "rest", "meal-1");
    expectConsistent(target);
    expect(target!.kcal).toBeCloseTo(1162 / 3, 5);
    expect(target!.protein).toBeCloseTo(136.6 / 3, 5);
    expect(target!.fat).toBeCloseTo(31 / 3, 5);
    // 4·136.6 + 9·31 = 825.4 kcal, so carbs get the remaining 336.6 kcal (84.15 g), just under
    // the 84.3 g left by themselves.
    expect(target!.carbs).toBeCloseTo((1162 - 4 * 136.6 - 9 * 31) / 4 / 3, 5);
  });
});

describe("remainingPool", () => {
  it("keeps kcal as what is left and trims carbs, then fat, before protein", () => {
    const used: Macros = { kcal: 1669, protein: 121.9, carbs: 135.8, fat: 70.7 };
    const pool = remainingPool(REST, used);
    expect(pool.kcal).toBeCloseTo(222, 5);
    expect(pool.protein).toBeCloseTo(55.5, 5);
    expect(pool).toMatchObject({ carbs: 0, fat: 0 });
  });

  it("is zero everywhere when the kcal are spent", () => {
    expect(remainingPool(REST, { kcal: 2500, protein: 10, carbs: 10, fat: 10 }))
      .toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
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

function randomMacros(next: () => number, scale: number): Macros {
  const protein = next() * 80 * scale;
  const carbs = next() * 100 * scale;
  const fat = next() * 40 * scale;
  // Food-database kcal drift from Atwater by up to ±25 %, and some logs carry kcal only.
  const kcal = next() < 0.1 ? next() * 600 * scale
    : (4 * protein + 4 * carbs + 9 * fat) * (0.75 + next() * 0.5);
  return { kcal, protein, carbs, fat };
}

function randomDay(seed: number): Store {
  const next = rng(seed);
  const store = owner();
  store.settings = { ...store.settings, mealsPerDay: 2 + Math.floor(next() * 5) } as Store["settings"];
  const slots = plannedSlotIds(store, DATE, "rest");
  const itemOverrides: Partial<Record<SlotId, SlotOverride>> = {};
  const eaten: Partial<Record<SlotId, string>> = {};
  for (const slot of slots) {
    const roll = next();
    if (roll < 0.35) itemOverrides[slot] = saved("Saved", [part("food", 100, randomMacros(next, 1 + next() * 2))]);
    else if (roll < 0.45) itemOverrides[slot] = { baseMealId: null, components: [], cleared: true } as SlotOverride;
    if (next() < 0.25) eaten[slot] = `${DATE}T12:00:00Z`;
  }
  const extras: LoggedFood[] = Array.from({ length: Math.floor(next() * 4) }, (_, i) => ({
    id: `e${i}`, foodId: "f", name: "Logged", portionLabel: "1", qty: 1, grams: 100,
    macros: randomMacros(next, 0.5 + next() * 2), at: `${DATE}T15:00:00Z`,
    ...(next() < 0.5 ? { slot: slots[Math.floor(next() * slots.length)] } : {}),
  }) as LoggedFood);
  store.days[DATE] = { date: DATE, itemOverrides, eaten, extras };
  return store;
}

describe("property: random days", () => {
  it("every slot target is non-negative, kcal covers its macros, and the open shares sum to the pool", () => {
    let checked = 0;
    for (let seed = 1; seed <= 500; seed += 1) {
      const store = randomDay(seed);
      const slots = plannedSlotIds(store, DATE, "rest");
      const open = slots.flatMap((slot) => {
        const share = scaledSlotTarget(store, DATE, "rest", slot);
        return share ? [share] : [];
      });
      for (const slot of slots) {
        const planning = planningSlotTarget(store, DATE, "rest", slot);
        if (planning) expectConsistent(planning);
      }
      if (open.length === 0) continue;
      open.forEach(expectConsistent);
      // Every open meal gets the same share of one pool.
      for (const share of open) expect(share).toEqual(open[0]);
      // The open shares sum to what is left of the day's kcal once the fixed meals and the logs
      // outside the slots are paid; no macro share exceeds what is left of that macro.
      const sum = open.reduce((acc, m) => ({ kcal: acc.kcal + m.kcal, protein: acc.protein + m.protein,
        carbs: acc.carbs + m.carbs, fat: acc.fat + m.fat }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
      // Random days hold no recipe snapshots, so a fixed slot is one whose override pays for it (a
      // saved meal at its foods, a cleared meal at zero) or an eaten mark with nothing saved: its
      // frozen share, or zero when a log filed under it is the record.
      const day = store.days[DATE]!;
      const empty: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      const fixedSpend = slots.filter((slot) => !scaledSlotTarget(store, DATE, "rest", slot))
        .flatMap((slot) => {
          const frozen = frozenEatenShare(store, DATE, "rest", slot);
          return frozen ? [{ macros: frozen }] : day.itemOverrides?.[slot]?.components ?? [];
        })
        .reduce((acc, c) => ({ kcal: acc.kcal + c.macros.kcal, protein: acc.protein + c.macros.protein,
          carbs: acc.carbs + c.macros.carbs, fat: acc.fat + c.macros.fat }), empty);
      const logs = loggedOutsideSlots(day);
      const used = { kcal: fixedSpend.kcal + logs.kcal, protein: fixedSpend.protein + logs.protein,
        carbs: fixedSpend.carbs + logs.carbs, fat: fixedSpend.fat + logs.fat };
      const pool = remainingPool(REST, used);
      expect(sum.kcal).toBeCloseTo(Math.max(0, REST.kcal - used.kcal), 6);
      expect(sum.protein).toBeCloseTo(pool.protein, 6);
      expect(sum.carbs).toBeCloseTo(pool.carbs, 6);
      expect(sum.fat).toBeCloseTo(pool.fat, 6);
      expect(sum.protein).toBeLessThanOrEqual(Math.max(0, REST.protein - used.protein) + 1e-6);
      checked += 1;
    }
    // The generator must reach days with open meals often enough to mean something.
    expect(checked).toBeGreaterThan(300);
  });
});
