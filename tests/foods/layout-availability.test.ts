import { describe, expect, it } from "vitest";
import { layoutMealsForDay, planMealsForDay } from "@/lib/foods/layout-plan";
import type { Food } from "@/lib/foods";
import type { SlotId } from "@/lib/types";

const food = (id: string, name: string, role: Food["role"]): Food => ({
  id, name, role, status: "eats", unit: "oz", updatedAt: "2026-09-27",
  perUnit: role === "protein" ? { protein: 10, carbs: 0, fat: 1 }
    : role === "carb" ? { protein: 0, carbs: 10, fat: 0 }
      : { protein: 0, carbs: 0, fat: 10 },
});
const slots = (["meal-1", "meal-2", "meal-3"] as SlotId[]).map((id) => ({
  id, target: { kcal: 500, protein: 30, carbs: 50, fat: 18 },
}));

const anchors = (rows: { meal: { components: { role: string; name: string }[] } }[]) =>
  rows.map((row) => row.meal.components.find((part) => part.role === "protein")?.name.toLowerCase());

describe("distinct proteins for generated meals (D5)", () => {
  it("does not count duplicate account rows of the same protein as separate options", () => {
    const foods = { tofu1: food("tofu1", "Tofu", "protein"),
      tofu2: food("tofu2", "tofu", "protein"), lentils: food("lentils", "Lentils", "protein"),
      rice: food("rice", "Rice", "carb"), oil: food("oil", "Olive oil", "fat") };
    // Two distinct proteins over three slots: one repeats, never in neighbouring slots.
    const two = layoutMealsForDay("2026-09-27", slots, foods);
    expect(two).toHaveLength(3);
    const names = anchors(two);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names[1]).not.toBe(names[2]);
    foods.tofu2 = food("tofu2", "Tempeh", "protein");
    const three = layoutMealsForDay("2026-09-27", slots, foods);
    expect(three).toHaveLength(3);
    expect(new Set(anchors(three)).size).toBe(3);
  });

  it("repeats the only protein next to itself rather than leave a slot empty (D5, amended)", () => {
    const foods = { tofu: food("tofu", "Tofu", "protein"), rice: food("rice", "Rice", "carb"),
      oil: food("oil", "Olive oil", "fat") };
    const timed = slots.map((slot, i) => ({ ...slot, clock: ["08:00", "12:30", "18:30"][i] }));
    const plan = planMealsForDay("2026-09-27", timed, foods);
    expect(plan.meals.map((row) => row.slot)).toEqual(["meal-1", "meal-2", "meal-3"]);
    expect(plan.shortages).toEqual([]);
  });
});
