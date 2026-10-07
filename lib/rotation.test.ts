import { describe, expect, it } from "vitest";
import type { Food } from "./foods";
import { daysSinceEpoch, mealFor, mealsForDay, poolFor, rotationIndex } from "./rotation";

function food(id: string, role: Food["role"]): Food {
  return { id, name: id, role, unit: "g", status: "eats", noCook: true,
    perUnit: role === "protein" ? { protein: 0.25, carbs: 0, fat: 0.04 }
      : role === "carb" ? { protein: 0.02, carbs: 0.28, fat: 0 }
        : { protein: 0, carbs: 0, fat: 0.2 },
    updatedAt: "2026-09-20T12:00:00Z" };
}

const foods = {
  p1: food("p1", "protein"), p2: food("p2", "protein"),
  c1: food("c1", "carb"), c2: food("c2", "carb"),
  f1: food("f1", "fat"), f2: food("f2", "fat"),
};

describe("date rotation", () => {
  it("handles dates on either side of the fixed epoch", () => {
    expect(daysSinceEpoch("2026-01-01")).toBe(0);
    expect(daysSinceEpoch("2025-12-31")).toBe(-1);
    expect(rotationIndex("2025-12-31", 3)).toBe(2);
  });

  it("never falls back to bundled meals for an account meal slot", () => {
    expect(poolFor("rest", "meal-1", {})).toEqual([]);
    expect(mealFor("2026-09-20", "meal-1", { foods: {} })).toBeNull();
  });

  it("requires an eats food in every macro role", () => {
    expect(poolFor("rest", "meal-1", { p1: foods.p1, c1: foods.c1 })).toEqual([]);
    expect(poolFor("rest", "meal-1", foods).length).toBeGreaterThan(0);
  });

  it("is deterministic for explicit account foods", () => {
    const first = mealsForDay("2026-09-20", undefined, "rest", foods);
    const second = mealsForDay("2026-09-20", undefined, "rest", foods);
    expect(second).toEqual(first);
    expect(first.filter((entry) => entry.slot.startsWith("meal-"))).toHaveLength(3);
  });

  it("respects an explicit composed swap while every referenced food still belongs to Eats", () => {
    const alternate = "compose:p2+c2+f2";
    const meal = mealFor("2026-09-20", "meal-1", {
      dayType: "rest", foods,
      stored: { date: "2026-09-20", swaps: { "meal-1": alternate } },
    });
    expect(meal?.id).toBe(alternate);
  });
});
