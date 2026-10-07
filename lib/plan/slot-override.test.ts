// lib/plan/slot-override.test.ts
/**
 * Phase A of docs/plans/2026-09-14-slot-item-editing.md.
 *
 * A card edit changes one line — the milk in the latte, the fruit in the pre-training carbs — and the
 * slot becomes what was actually eaten. The logging ruling: recalculate and show the difference, do NOT
 * resize the other items to hold the target. lib/scaling.ts still sizes the authored plan and
 * still never moves protein; nothing here touches it.
 */
import { describe, expect, it } from "vitest";
import {
  addComponent, componentsForSlot, removeComponent, replaceComponent, setComponentQty,
  slotDifference, stepComponent, sumComponents,
} from "@/lib/plan/slot-override";
import type { FoodComponent, Macros } from "@/lib/types";

const oatMilk: FoodComponent = {
  name: "Oat milk", qty: 1, unit: "cup", role: "free",
  macros: { kcal: 125, protein: 3, carbs: 17, fat: 5 },
};
const wholeMilk: FoodComponent = {
  name: "Whole milk", qty: 1, unit: "cup", role: "free",
  macros: { kcal: 168, protein: 8, carbs: 12, fat: 9 },
};
const espresso: FoodComponent = {
  name: "Espresso", qty: 1, unit: "oz", role: "free",
  macros: { kcal: 3, protein: 0, carbs: 1, fat: 0 },
};

describe("componentsForSlot", () => {
  it("shows the planned components when the slot has not been edited", () => {
    expect(componentsForSlot([espresso, oatMilk], undefined)).toEqual([espresso, oatMilk]);
  });

  it("shows what was actually eaten once the slot has been edited", () => {
    const override = { baseMealId: "coffee-latte", components: [espresso, wholeMilk] };
    expect(componentsForSlot([espresso, oatMilk], override)).toEqual([espresso, wholeMilk]);
  });

  it("leaves every other component exactly as it was — no rebalancing", () => {
    const override = { baseMealId: "coffee-latte", components: [espresso, wholeMilk] };
    const shown = componentsForSlot([espresso, oatMilk], override);
    expect(shown[0]).toEqual(espresso);
    expect(shown[0].qty).toBe(1);
    expect(shown[0].macros).toEqual({ kcal: 3, protein: 0, carbs: 1, fat: 0 });
  });

  it("removes a line", () => {
    const override = { baseMealId: "coffee-latte", components: [espresso] };
    expect(componentsForSlot([espresso, oatMilk], override)).toEqual([espresso]);
  });

  it("treats an emptied slot as an edit, not as an absent one", () => {
    const override = { baseMealId: "coffee-latte", components: [] };
    expect(componentsForSlot([espresso, oatMilk], override)).toEqual([]);
  });
});

describe("sumComponents", () => {
  it("adds the macros of what is actually on the card", () => {
    expect(sumComponents([espresso, wholeMilk]))
      .toEqual({ kcal: 171, protein: 8, carbs: 13, fat: 9 });
  });

  it("is all zeroes for an empty slot", () => {
    expect(sumComponents([])).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });
});

describe("slotDifference", () => {
  const target: Macros = { kcal: 128, protein: 3, carbs: 18, fat: 5 };

  it("reports how far the slot now sits from its target", () => {
    const actual = sumComponents([espresso, wholeMilk]);
    expect(slotDifference(actual, target)).toEqual({ kcal: 43, protein: 5, carbs: -5, fat: 4 });
  });

  it("is all zeroes when the slot is exactly on target", () => {
    expect(slotDifference(target, target)).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });

  it("has nothing to say when the slot has no target", () => {
    expect(slotDifference({ kcal: 171, protein: 8, carbs: 13, fat: 9 }, undefined)).toBeNull();
  });
});

describe("editing one line", () => {
  const planned = [espresso, oatMilk];

  it("swaps the milk and leaves the espresso exactly as it was", () => {
    const next = replaceComponent(planned, 1, wholeMilk);
    expect(next).toEqual([espresso, wholeMilk]);
    expect(next[0]).toEqual(espresso);
  });

  it("removes the line that was not eaten", () => {
    expect(removeComponent(planned, 1)).toEqual([espresso]);
  });

  it("adds a line that was eaten", () => {
    expect(addComponent(planned, wholeMilk)).toEqual([espresso, oatMilk, wholeMilk]);
  });

  it("never mutates the list it was given", () => {
    const original = [espresso, oatMilk];
    replaceComponent(original, 1, wholeMilk);
    removeComponent(original, 0);
    addComponent(original, wholeMilk);
    expect(original).toEqual([espresso, oatMilk]);
  });

  it("leaves the list alone when the index is not one of its lines", () => {
    expect(replaceComponent(planned, 5, wholeMilk)).toEqual(planned);
    expect(removeComponent(planned, -1)).toEqual(planned);
  });
});

describe("setComponentQty", () => {
  it("doubles the macros for two cups instead of one", () => {
    expect(setComponentQty(oatMilk, 2)).toEqual({
      ...oatMilk, qty: 2, macros: { kcal: 250, protein: 6, carbs: 34, fat: 10 },
    });
  });

  it("halves them for a half serving", () => {
    expect(setComponentQty(oatMilk, 0.5).macros).toEqual({ kcal: 63, protein: 1.5, carbs: 8.5, fat: 2.5 });
  });

  it("zeroes the macros when none was eaten", () => {
    expect(setComponentQty(oatMilk, 0).macros).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });

  it("refuses a negative quantity rather than inventing negative calories", () => {
    expect(setComponentQty(oatMilk, -1)).toEqual(oatMilk);
  });

  it("leaves a zero-quantity line alone — there is nothing to scale from", () => {
    const odd = { ...oatMilk, qty: 0 };
    expect(setComponentQty(odd, 3)).toEqual(odd);
  });

  it("does not mutate the line it was given", () => {
    const original = { ...oatMilk };
    setComponentQty(original, 5);
    expect(original).toEqual(oatMilk);
  });
});

describe("stepComponent", () => {
  const planned = [espresso, oatMilk];

  it("one more cup scales that line and leaves the other alone", () => {
    const next = stepComponent(planned, 1, 1);
    expect(next[1].qty).toBe(2);
    expect(next[1].macros).toEqual({ kcal: 250, protein: 6, carbs: 34, fat: 10 });
    expect(next[0]).toEqual(espresso);
  });

  it("one less takes a two-cup line back to one", () => {
    const two = [espresso, setComponentQty(oatMilk, 2)];
    expect(stepComponent(two, 1, -1)[1].qty).toBe(1);
  });

  /**
   * Stepping the last one off IS how a line is removed — there is no separate remove button,
   * because "I only had the banana" and "I did not have it" are the same gesture continued.
   */
  it("stepping below one takes the line off entirely", () => {
    expect(stepComponent(planned, 1, -1)).toEqual([espresso]);
  });

  it("takes a part-quantity line off too, rather than leaving a zero on the card", () => {
    const half = [espresso, setComponentQty(oatMilk, 0.5)];
    expect(stepComponent(half, 1, -1)).toEqual([espresso]);
  });

  it("never mutates the list it was given", () => {
    const original = [espresso, oatMilk];
    stepComponent(original, 1, 1);
    stepComponent(original, 1, -1);
    expect(original).toEqual([espresso, oatMilk]);
  });

  it("leaves the list alone for a line that is not there", () => {
    expect(stepComponent(planned, 5, 1)).toEqual(planned);
    expect(stepComponent(planned, -1, -1)).toEqual(planned);
  });
});
