import { describe, expect, it } from "vitest";
import { BREAKFAST, brokenRules, eats, F, MAIN } from "@/tests/helpers/meal-foods";
import type { Food } from "@/lib/foods";
import { planDay } from "./day";
import { occasionAt } from "./occasion";
import { rankPlates } from "./plate";

const DATE = "2026-10-04";
const CLOCKS = ["07:30", "12:30", "19:00"] as const;
const anchorOf = (plate: { rows: { part: string; food: { id: string } }[] }) =>
  plate.rows.find((row) => row.part === "anchor")?.food.id;

describe("acceptance (c): sparse Eats (D5)", () => {
  it("spreads two proteins over four slots, repeating only in non-neighbouring slots", () => {
    const foods = eats(F.eggs, F.tuna, F.rice, F.oats, F.banana, F.broccoli, F.oliveOil);
    const plan = planDay(DATE, ["07:30", "12:30", "15:30", "19:00"].map((clock, i) => ({
      id: `meal-${i + 1}` as "meal-1", target: i === 0 ? BREAKFAST : MAIN, clock })), foods);
    expect(plan.shortages).toEqual([]);
    const anchors = plan.plates.map(({ plate }) => anchorOf(plate));
    expect(anchors).toHaveLength(4);
    expect(new Set(anchors)).toEqual(new Set(["eggs", "tuna"]));
    for (let i = 1; i < anchors.length; i += 1) expect(anchors[i]).not.toBe(anchors[i - 1]);
    for (const { plate } of plan.plates) expect(brokenRules(plate)).toEqual([]);
  });

  it("prefers distinct anchors when Eats has enough, even when one suits two slots best", () => {
    const foods = eats(F.eggs, F.yogurt, F.tuna, F.oats, F.toast, F.banana, F.rice, F.broccoli, F.oliveOil);
    const plan = planDay(DATE, CLOCKS.map((clock, i) => ({ id: `meal-${i + 1}` as "meal-1",
      target: i === 0 ? BREAKFAST : MAIN, clock })), foods);
    const anchors = plan.plates.map(({ plate }) => anchorOf(plate));
    expect(new Set(anchors).size).toBe(3);
    // Yogurt is never a dinner in the table, so the assignment keeps it at breakfast.
    expect(anchors[2]).not.toBe("yogurt");
  });

  it("repeats the only protein in neighbouring slots rather than leave one empty (D5, amended)", () => {
    const plan = planDay("2026-09-27", [
      { id: "meal-1", clock: "08:00", target: { kcal: 500, protein: 35, carbs: 50, fat: 15 } },
      { id: "meal-2", clock: "12:30", target: { kcal: 600, protein: 40, carbs: 60, fat: 20 } },
      { id: "meal-3", clock: "18:30", target: { kcal: 600, protein: 40, carbs: 60, fat: 20 } },
    ], [F.tofu, F.rice, F.broccoli]);
    expect(plan.shortages).toEqual([]);
    expect(plan.plates.map((row) => row.plate.anchor?.id)).toEqual(["tofu", "tofu", "tofu"]);
  });
});

/** Cuisine smoke set (D6): mostly-one-cuisine Eats lists each get a whole, valid day. */
const CUISINES: Record<string, Food[]> = {
  "South Asian": [F.dal, F.paneer, F.roti, F.rice, F.spinach, F.ghee],
  "East Asian": [F.tofu, F.rice, F.bokChoy, F.eggs, F.sesameOil],
  "Latin American": [F.blackBeans, F.tortilla, F.eggs, F.avocado],
  Mediterranean: [F.chickpeas, F.feta, F.bread, F.tomato, F.oliveOil],
};

describe("cuisine smoke set", () => {
  for (const [cuisine, list] of Object.entries(CUISINES)) {
    it(`${cuisine}: template-valid, non-empty plates at 07:30, 12:30 and 19:00`, () => {
      const foods = eats(...list);
      for (const clock of CLOCKS) {
        const occasion = occasionAt(clock);
        const target = occasion === "breakfast" ? BREAKFAST : MAIN;
        const { plates, shortage } = rankPlates({ date: DATE, slot: "meal-1", occasion, target, foods });
        expect([clock, shortage]).toEqual([clock, null]);
        expect(plates[0].components.length).toBeGreaterThanOrEqual(2);
        for (const plate of plates) expect([clock, plate.name, brokenRules(plate)]).toEqual([clock, plate.name, []]);
        // A vegetable is a preference on a main (not a rule), and the chosen plate keeps it.
        if (occasion !== "breakfast" && list.some((food) => food.role === "carb" && /spinach|bok choy|tomato|broccoli|pepper|beans, green/i.test(food.name))) {
          expect([clock, plates[0].rows.some((row) => row.part === "veg")]).toEqual([clock, true]);
        }
      }
    });
  }

  it("lays out whole days for the cuisine sets with two or more proteins", () => {
    for (const cuisine of ["South Asian", "East Asian", "Latin American"]) {
      const plan = planDay(DATE, CLOCKS.map((clock, i) => ({ id: `meal-${i + 1}` as "meal-1",
        target: i === 0 ? BREAKFAST : MAIN, clock })), eats(...CUISINES[cuisine]));
      expect([cuisine, plan.shortages]).toEqual([cuisine, []]);
      expect(plan.plates).toHaveLength(3);
    }
  });
});
