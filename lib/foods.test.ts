import { describe, expect, it } from "vitest";
import {
  applyAvoidOffer, bannedReason, composeMeal, foodToAvoid, noteSuggestsAvoid, rotationPool,
  type Food,
} from "./foods";

function food(id: string, role: Food["role"], status: Food["status"] = "eats"): Food {
  return { id, name: id, role, unit: "g", status,
    perUnit: role === "protein" ? { protein: 0.25, carbs: 0, fat: 0.04 }
      : role === "carb" ? { protein: 0.02, carbs: 0.28, fat: 0 }
        : { protein: 0, carbs: 0, fat: 0.2 },
    updatedAt: "2026-09-20T12:00:00Z" };
}

describe("account-owned foods", () => {
  it("has no code-level dietary blacklist", () => {
    expect(bannedReason("Any named food")).toBeNull();
    expect(bannedReason(" ")).toBe("Enter a food name.");
  });

  it("returns no rotation candidate when any macro role is absent", () => {
    expect(rotationPool("rest", "meal-1", { kcal: 600, protein: 40, carbs: 60, fat: 20 }, {
      protein: food("protein", "protein"), carb: food("carb", "carb"),
    })).toEqual([]);
  });

  it("composes only the selected account foods", () => {
    const meal = composeMeal("meal-1", { kcal: 600, protein: 40, carbs: 60, fat: 20 }, {
      protein: food("protein", "protein"), carb: food("carb", "carb"), fat: food("fat", "fat"),
    });
    expect(meal.components.map((component) => component.role)).toEqual(["protein", "carb", "fat"]);
  });

  it("serves a small positive fat need at the smallest step when the plate's calories allow it", () => {
    const oil: Food = { ...food("oil", "fat"), unit: "tbsp", perUnit: { protein: 0, carbs: 0, fat: 14 } };
    const picks = { protein: food("protein", "protein"), carb: food("carb", "carb"), fat: oil };
    // Review round 5: the 160 g protein food brings 6 g fat against a 9 g target; 3 g is under half
    // a tablespoon of oil, and it is still served (0.5 tbsp) rather than left at 6 g.
    const nine = composeMeal("meal-1", { kcal: 600, protein: 40, carbs: 60, fat: 9 }, picks);
    expect(nine.components.find((c) => c.role === "fat")?.qty).toBe(0.5);
    // 5 g short is 0.36 tbsp: served as half a tablespoon, never rounded away (audit N1).
    const short = composeMeal("meal-1", { kcal: 600, protein: 40, carbs: 60, fat: 11 }, picks);
    expect(short.components.find((c) => c.role === "fat")?.qty).toBe(0.5);
  });

  it("leaves a sliver of fat off only when the step would break the calorie tolerance", () => {
    const oil: Food = { ...food("oil", "fat"), unit: "tbsp", perUnit: { protein: 0, carbs: 0, fat: 14 } };
    const picks = { protein: food("protein", "protein"), carb: food("carb", "carb"), fat: oil };
    // The plate is ~470 kcal against a 470 target: +63 kcal of oil would pass the 10 % band.
    const tight = composeMeal("meal-1", { kcal: 470, protein: 40, carbs: 60, fat: 7 }, picks);
    expect(tight.components.map((c) => c.role)).toEqual(["protein", "carb"]);
  });

  describe("every fat step stays inside the 10 % calorie tolerance (review round 6)", () => {
    const chicken: Food = { ...food("chicken", "protein"), unit: "oz", perUnit: { protein: 6, carbs: 0, fat: 0.5 } };
    const bread: Food = { ...food("bread", "carb"), unit: "whole", perUnit: { protein: 2, carbs: 10, fat: 0 } };
    const kcalOf = (meal: ReturnType<typeof composeMeal>) => meal.components
      .reduce((sum, c) => sum + c.macros.kcal, 0);

    it("leaves the oil off when even one step would pass the limit (the 145 kcal probe)", () => {
      const oil: Food = { ...food("oil", "fat"), unit: "oz", perUnit: { protein: 0, carbs: 0, fat: 5 } };
      // Chicken 3.5 oz + 1 bread is 150 kcal with 2 g fat; a 2.6 g fat need is over half an
      // ounce-step of this oil, and 0.5 oz would make the plate 177 kcal against a 159.5 limit.
      const meal = composeMeal("meal-1", { kcal: 145, protein: 20, carbs: 10, fat: 4.6 },
        { protein: chicken, carb: bread, fat: oil });
      expect(meal.components.map((c) => c.role)).toEqual(["protein", "carb"]);
      expect(kcalOf(meal)).toBeLessThanOrEqual(145 * 1.1);
    });

    it("steps the oil down until it fits rather than dropping it", () => {
      const oil: Food = { ...food("oil", "fat"), unit: "oz", perUnit: { protein: 0, carbs: 0, fat: 8 } };
      // An 8 g need is 1 oz (+72 kcal → 222 > 220); half an ounce (+36 → 186) fits.
      const meal = composeMeal("meal-1", { kcal: 200, protein: 20, carbs: 10, fat: 10 },
        { protein: chicken, carb: bread, fat: oil });
      expect(meal.components.find((c) => c.role === "fat")?.qty).toBe(0.5);
      expect(kcalOf(meal)).toBeLessThanOrEqual(220);
    });
  });

  it("never omits a small positive protein or carb need", () => {
    const tuna: Food = { ...food("tuna", "protein"), unit: "oz", perUnit: { protein: 40, carbs: 0, fat: 1 } };
    const oats: Food = { ...food("oats", "carb"), unit: "cup", perUnit: { protein: 5, carbs: 100, fat: 3 } };
    // 6 g protein is 0.15 oz and 10 g carbs 0.1 cup: both under half a step, both still served.
    const meal = composeMeal("meal-1", { kcal: 100, protein: 6, carbs: 10, fat: 0 },
      { protein: tuna, carb: oats, fat: food("fat", "fat") });
    expect(meal.components.find((c) => c.role === "protein")?.qty).toBe(0.5);
    expect(meal.components.find((c) => c.role === "carb")?.qty).toBe(0.25);
  });

  it("moves a food to Avoid without deleting its note", () => {
    const original = { ...food("food", "carb"), note: "did not work" };
    expect(foodToAvoid(original)).toMatchObject({ status: "avoid", note: "did not work" });
    expect(applyAvoidOffer(original)).toMatchObject({ status: "avoid" });
  });

  it("recognizes a bounded problem note", () => {
    expect(noteSuggestsAvoid("felt bloated later")).toBe(true);
    expect(noteSuggestsAvoid("painting the kitchen")).toBe(false);
  });
});
