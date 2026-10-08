/**
 * Phase 18 W11 acceptance 1 through the day planner (Sol W11 r1 BLOCK 2): with shopping focus on,
 * `planDay` keeps the key (fits, coverage, score) slot by slot, in both its search and its
 * assignment path; a higher-scoring plate with less coverage never wins a slot. With focus off the
 * day is byte-identical to the day without the argument.
 */
import { describe, expect, it } from "vitest";
import { planDay, type DaySlot } from "@/lib/meals/day";
import { foodKey } from "@/lib/meals/parts";
import { rankPlates, type FocusRanking } from "@/lib/meals/plate";
import { coverageOf } from "@/lib/shopping/focus";
import type { Food } from "@/lib/foods";
import type { SlotId } from "@/lib/types";
import { eats, F, MAIN } from "@/tests/helpers/meal-foods";

const DATE = "2026-10-05";
const focusOver = (used: Set<string>): FocusRanking => ({ coverageOf: (items) => coverageOf(items, used) });

/** The best (fits, coverage) a slot can have on its own under `focus`. */
function bestKeyFor(slot: DaySlot, foods: Record<string, Food>, focus: FocusRanking): [boolean, number] {
  const { plates } = rankPlates({ date: DATE, slot: slot.id, occasion: slot.occasion ?? "lunch",
    target: slot.target, foods: Object.values(foods), focus });
  const best = plates[0];
  return [best.fits, best.coverage ?? 0];
}

describe("W11: planDay honours the highest coverage under focus", () => {
  const foods = eats(F.chicken, F.tuna, F.lentils, F.tofu, F.rice, F.broccoli, F.oliveOil, F.avocado);
  const slots: DaySlot[] = [
    { id: "meal-2", target: MAIN, clock: "12:30" },
    { id: "meal-3", target: MAIN, clock: "19:00" },
  ];

  it("a higher-scoring uncovered anchor loses each slot to covered ones", () => {
    const plain = planDay(DATE, slots, foods);
    // The plain day's best plate is chicken; everything else is on the list.
    expect(plain.plates[0].plate.anchorKey).toBe(foodKey(F.chicken));
    const used = new Set(Object.values(foods).map(foodKey).filter((key) => key !== foodKey(F.chicken)));
    const focus = focusOver(used);
    const focused = planDay(DATE, slots, foods, undefined, undefined, undefined, undefined, focus);
    expect(focused.plates).toHaveLength(2);
    for (const { slot, plate } of focused.plates) {
      expect(plate.anchorKey).not.toBe(foodKey(F.chicken));
      const row = slots.find((entry) => entry.id === slot) as DaySlot;
      expect([plate.fits, plate.coverage]).toEqual(bestKeyFor({ ...row, occasion: plate.occasion }, foods, focus));
      expect(plate.coverage).toBe(1);
    }
  });

  it("with one covered anchor, the neighbour takes the next-highest coverage, not a repeat", () => {
    const plainAnchors = planDay(DATE, slots, foods).plates.map(({ plate }) => plate.anchorKey);
    const used = new Set(Object.values(foods).map(foodKey).filter((key) => !plainAnchors.includes(key)));
    const focused = planDay(DATE, slots, foods, undefined, undefined, undefined, undefined, focusOver(used));
    const coverages = focused.plates.map(({ plate }) => plate.coverage);
    expect(coverages).toContain(1);
    expect(new Set(focused.plates.map(({ plate }) => plate.anchorKey)).size).toBe(2);
  });

  it("the assignment path (a day too large to search) keeps the same key", () => {
    const many = eats(F.chicken, F.tuna, F.lentils, F.tofu, F.quorn, F.chickpeas, F.blackBeans, F.dal,
      F.paneer, F.eggs, F.rice, F.broccoli, F.oliveOil, F.avocado);
    const six: DaySlot[] = ["07:00", "10:00", "12:30", "15:00", "18:00", "20:30"]
      .map((clock, i) => ({ id: `meal-${i + 1}` as SlotId, target: MAIN, clock, occasion: "lunch" as const }));
    const used = new Set(Object.values(many).map(foodKey)
      .filter((key) => key !== foodKey(F.chicken) && key !== foodKey(F.tuna)));
    const focus = focusOver(used);
    const { plates } = rankPlates({ date: DATE, slot: "meal-1", occasion: "lunch", target: MAIN,
      foods: Object.values(many), focus });
    const fullyCovered = new Set(plates.filter((plate) => plate.fits && plate.coverage === 1)
      .map((plate) => plate.anchorKey));
    expect(fullyCovered.size).toBeGreaterThan(1);
    const focused = planDay(DATE, six, many, undefined, undefined, undefined, undefined, focus);
    const anchors = focused.plates.map(({ plate }) => plate.anchorKey);
    const covered = focused.plates.filter(({ plate }) => plate.fits && plate.coverage === 1).length;
    expect(covered).toBe(Math.min(six.length, fullyCovered.size));
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("is byte-identical with focus absent", () => {
    expect(JSON.stringify(planDay(DATE, slots, foods, undefined, undefined, undefined, undefined, undefined)))
      .toBe(JSON.stringify(planDay(DATE, slots, foods)));
  });
});
