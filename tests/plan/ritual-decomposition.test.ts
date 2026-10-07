/**
 * Phase B of docs/plans/2026-09-14-slot-item-editing.md.
 *
 * Phase A made every line in a slot editable, and opening the latte showed why that was not yet
 * enough: the latte is ONE authored component called "Oat milk latte", so there is no milk to tap.
 * Same for the pre-training carbs — a two-food option written as one line cannot record that only
 * had only one of them.
 *
 * Splitting them changes presentation ONLY. `Meal.macros` is documented as "Sum of components.
 * Precomputed for speed; must be validated by test", and ../analysis/targets.md owns every calorie
 * and macro — so the totals below were recorded from the library BEFORE the split and must come
 * back identical after it. A split that cannot hold its total does not ship.
 */
import { describe, expect, it } from "vitest";
import { getMealOptions } from "@/lib/meals";
import type { DayType, Meal, SlotId } from "@/lib/types";

const DAY_TYPES: DayType[] = ["training-10", "training-7-fasted", "rest"];
const RITUAL_SLOTS: SlotId[] = ["coffee", "pouches-pre", "post-refuel", "hot-chocolate"];

function allRituals(): Map<string, Meal> {
  const found = new Map<string, Meal>();
  for (const dayType of DAY_TYPES) {
    for (const slot of RITUAL_SLOTS) {
      for (const meal of getMealOptions(dayType, slot)) found.set(meal.id, meal);
    }
  }
  return found;
}

/**
 * Recorded from the library on 2026-09-14, before the split. kcal, protein, carbs, fat.
 * The pouch options were replaced by real-food carbs on 2026-09-18 after a bloating report;
 * the ids changed, every total did not — which is the whole point of this table.
 */
const BEFORE_THE_SPLIT: Record<string, [number, number, number, number]> = {
  "coffee--black-coffee": [0, 0, 0, 0],
  "coffee--latte": [125, 3, 17, 5],
  "hot-chocolate--om-mushroom-hot-chocolate": [154, 3, 22, 6],
  "post-refuel--shake-banana-latte": [488, 30, 65, 12],
  "post-refuel--shake-banana-jasmine-rice-latte": [488, 30, 65, 12],
  "post-refuel--shake-banana-melon-latte": [488, 30, 65, 12],
  "post-refuel--shake-banana-sweet-potato-latte": [488, 30, 65, 12],
  "post-refuel--shake-banana-white-rice-latte": [488, 30, 65, 12],
  "pouches-pre--banana-cup-melon": [148, 1, 36, 0],
  "pouches-pre--butternut-squash-half-a-banana": [148, 1, 36, 0],
  "pouches-pre--jasmine-rice-cup": [148, 1, 36, 0],
  "pouches-pre--sweet-potato-cup": [148, 1, 36, 0],
  "pouches-pre--white-rice-cup": [148, 1, 36, 0],
};

describe("splitting a ritual changes nothing about its numbers", () => {
  it("every ritual still totals exactly what it did before", () => {
    const rituals = allRituals();
    for (const [id, [kcal, protein, carbs, fat]] of Object.entries(BEFORE_THE_SPLIT)) {
      const meal = rituals.get(id);
      expect(meal, `${id} disappeared from the library`).toBeDefined();
      expect([meal!.macros.kcal, meal!.macros.protein, meal!.macros.carbs, meal!.macros.fat],
        `${id} changed its totals`).toEqual([kcal, protein, carbs, fat]);
    }
  });

  it("no ritual was added or dropped by the split", () => {
    expect([...allRituals().keys()].sort()).toEqual(Object.keys(BEFORE_THE_SPLIT).sort());
  });

  it("each ritual's stated macros still equal the sum of its lines", () => {
    for (const meal of allRituals().values()) {
      const summed = meal.components.reduce(
        (t, c) => ({
          kcal: t.kcal + c.macros.kcal, protein: t.protein + c.macros.protein,
          carbs: t.carbs + c.macros.carbs, fat: t.fat + c.macros.fat,
        }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
      expect(summed.protein, `${meal.id} protein`).toBeCloseTo(meal.macros.protein, 5);
      expect(summed.carbs, `${meal.id} carbs`).toBeCloseTo(meal.macros.carbs, 5);
      expect(summed.fat, `${meal.id} fat`).toBeCloseTo(meal.macros.fat, 5);
    }
  });
});

describe("editable rituals have separate lines", () => {
  it("the latte separates the milk from the coffee so the milk can change", () => {
    const latte = allRituals().get("coffee--latte")!;
    expect(latte.components.length).toBeGreaterThan(1);
    expect(latte.components.some((c) => /milk/i.test(c.name))).toBe(true);
  });

  it("a two-food pre-training slot is two lines so only one can be logged", () => {
    const carbs = allRituals().get("pouches-pre--banana-cup-melon")!;
    expect(carbs.components.length).toBe(2);
    for (const c of carbs.components) expect(c.qty).toBeGreaterThan(0);
  });

  it("each pre-training line names its OWN food, so the two are told apart", () => {
    const carbs = allRituals().get("pouches-pre--banana-cup-melon")!;
    const names = carbs.components.map((c) => c.name.toLowerCase());
    // Two distinct lines: one banana, one melon — not one line whose name happens to say both.
    expect(new Set(names).size).toBe(2);
    expect(names.filter((n) => n.includes("banana"))).toHaveLength(1);
    expect(names.filter((n) => n.includes("melon"))).toHaveLength(1);
  });

  it("the hot chocolate separates its milk too", () => {
    const hot = allRituals().get("hot-chocolate--om-mushroom-hot-chocolate")!;
    expect(hot.components.length).toBeGreaterThan(1);
    expect(hot.components.some((c) => /milk/i.test(c.name))).toBe(true);
  });
});
