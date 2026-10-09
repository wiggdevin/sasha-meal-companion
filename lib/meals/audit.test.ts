/**
 * Regressions from the GPT-6 Sol audit of Phase 17 O1 (~/Inbox/notes/sasha-o1-review-gpt6.md).
 */
import { describe, expect, it } from "vitest";
import { eats, F, food, MAIN } from "@/tests/helpers/meal-foods";
import { planDay } from "./day";
import { byCode } from "./parts";
import { rankPlates } from "./plate";

const DATE = "2026-10-04";
const lunch = (foods: Record<string, ReturnType<typeof food>>, target = MAIN) =>
  rankPlates({ date: DATE, slot: "meal-2", occasion: "lunch", target, foods });

describe("O1 audit regressions", () => {
  it("anchors legumes and paneer whatever role the account stored (BLOCK 2)", () => {
    const sides = [F.rice, F.roti, F.spinach];
    for (const anchor of [{ ...F.dal, role: "carb" as const }, { ...F.blackBeans, role: "carb" as const },
      { ...F.chickpeas, role: "carb" as const }, { ...F.paneer, role: "fat" as const }]) {
      const { plates, shortage } = lunch(eats(anchor, ...sides));
      expect([anchor.id, shortage]).toEqual([anchor.id, null]);
      expect(plates[0].anchor?.id).toBe(anchor.id);
    }
  });

  it("never lets a vegetable lead a plate, even a protein-dense one or green beans", () => {
    const greenBeans = food("green-beans", "Green beans, cooked", "carb", [1.9, 7.9, 0.3]);
    const { plates } = lunch(eats(F.chicken, F.rice, F.broccoli, F.spinach, greenBeans));
    expect(new Set(plates.map((plate) => plate.anchor?.id))).toEqual(new Set(["chicken"]));
  });

  it("serves a mixed dish as a whole plate (BLOCK 3)", () => {
    const dish = food("chicken-rice", "Chicken and rice", "protein", [12, 20, 4]);
    const { plates, shortage } = lunch(eats(dish));
    expect(shortage).toBeNull();
    expect(plates[0].anchor?.id).toBe("chicken-rice");
  });

  it("does not lose a servable side to better-paired ones it cannot serve (BLOCK 4)", () => {
    const pack = (id: string) => ({ ...food(id, `Rice meal pack ${id}`, "carb", [3, 100, 2]), unit: "whole" as const });
    const { plates, shortage } = lunch(eats(F.chicken, F.tortilla, pack("a"), pack("b")));
    expect(shortage).toBeNull();
    expect(plates.length).toBeGreaterThan(0);
  });

  it("orders by code point, never by the runtime's locale (BLOCK 6)", () => {
    expect(["Z protein", "Ä protein", "a protein"].sort(byCode)).toEqual(["Z protein", "a protein", "Ä protein"]);
  });

  it("says when the closest plate misses the protein (BLOCK 7)", () => {
    const plan = planDay(DATE, [{ id: "meal-2", clock: "12:30",
      target: { kcal: 880, protein: 110, carbs: 70, fat: 25 } }], eats(F.chicken, F.rice, F.broccoli, F.oliveOil));
    expect(plan.plates).toHaveLength(1);
    expect(plan.misses).toEqual([{ slot: "meal-2",
      reason: "These foods can’t reach this meal’s protein in usual portions" }]);
  });

  it("keeps fruit off a savoury breakfast and away from a vegetable (WARN 8)", () => {
    const { plates } = rankPlates({ date: DATE, slot: "meal-1", occasion: "breakfast",
      target: { kcal: 500, protein: 35, carbs: 55, fat: 14 }, foods: eats(F.eggs, F.rice, F.banana, F.broccoli) });
    for (const plate of plates) {
      const parts = plate.rows.map((row) => row.part);
      expect([plate.name, parts.includes("fruit") && (parts.includes("veg") || parts.includes("starch"))])
        .toEqual([plate.name, false]);
    }
  });

  it("keeps yogurt with porridge or bread, not rice, at breakfast", () => {
    const { plates } = rankPlates({ date: DATE, slot: "meal-1", occasion: "breakfast",
      target: { kcal: 500, protein: 35, carbs: 55, fat: 14 }, foods: eats(F.eggs, F.yogurt, F.rice, F.oats) });
    for (const plate of plates) {
      const names = plate.rows.map((row) => row.food.id);
      expect([plate.name, names.includes("yogurt") && names.includes("rice")]).toEqual([plate.name, false]);
    }
  });

  it("does not let a family name alone make a carb an anchor (round 2, finding 12)", () => {
    const flavoured = food("chicken-rice-mix", "Chicken flavored rice", "carb", [2, 28, 1]);
    const { plates, shortage } = lunch(eats(flavoured, F.rice, F.broccoli));
    expect(plates).toEqual([]);
    expect(shortage?.missing).toEqual(["anchor"]);
  });

  it("serves yogurt with a flatbread at breakfast, and names the base it lacks (round 2, finding 13)", () => {
    const breakfast = (foods: Record<string, ReturnType<typeof food>>) => rankPlates({ date: DATE,
      slot: "meal-1", occasion: "breakfast", target: { kcal: 500, protein: 35, carbs: 55, fat: 14 }, foods });
    expect(breakfast(eats(F.yogurt, F.roti)).shortage).toBeNull();
    expect(breakfast(eats(F.yogurt, F.rice)).shortage)
      .toEqual({ missing: ["starch"], reason: "No bread, porridge or cereal fits this meal yet — try another food" });
  });
});
