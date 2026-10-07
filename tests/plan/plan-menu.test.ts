/**
 * The menu screen (lib/server/plan-menu.ts) and an uploaded plan's matched meal as a card
 * (lib/plan/document-meal.ts): a dish whose names were not all looked up is dropped, never shown
 * unchecked; the card's fit flag comes from its totals against the slot. No I/O.
 */
import { describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { documentMeal } from "@/lib/plan/document-meal";
import type { MenuCandidate } from "@/lib/plan/photo-result";
import { MAX_MENU_LOOKUPS, screenMenu } from "@/lib/server/plan-menu";

const dish = (name: string, kcal: number, ingredients: string[]): MenuCandidate =>
  ({ name, kcal, protein: 30, carbs: 40, fat: 15, tip: null, check: null, ingredients });

describe("menu screen lookup budget", () => {
  it("drops a dish it could not fully look up instead of showing it unchecked", async () => {
    const names = (i: number) => Array.from({ length: 12 }, (_, n) => `food ${i}-${n}`);
    const menu = [1, 2, 3, 4, 5].map((i) => dish(`Dish ${i}`, 600, names(i)));
    // Every dish name is on Avoid, so screening runs on until the budget is spent.
    const searchFoods = vi.fn(async (_u: string, query: string) => [{ foodRefId: `${query}-ref`, name: query,
      brand: null, kcalPer100g: 100, prefStatus: query.startsWith("Dish") ? "avoid" as const : null }]);
    const out = await screenMenu("u", menu, 600, EMPTY_PROFILE, searchFoods);
    expect(out).toEqual([]);
    expect(searchFoods.mock.calls.length).toBeLessThanOrEqual(MAX_MENU_LOOKUPS);
  });

  it("asks the search once per distinct name", async () => {
    const searchFoods = vi.fn(async (_u: string, _query: string) => []);
    const out = await screenMenu("u", [dish("Rice bowl", 600, ["rice", "Rice"]), dish("Fried rice", 620, ["rice"])],
      600, EMPTY_PROFILE, searchFoods);
    expect(out.map((pick) => pick.name)).toEqual(["Rice bowl", "Fried rice"]);
    expect(searchFoods.mock.calls.map((call) => call[1])).toEqual(["Rice bowl", "rice", "Fried rice"]);
  });
});

describe("an uploaded plan's meal as a card", () => {
  const match = (kcal: number, protein: number) => ({ day: 0, meal: 0, title: "Lunch", items: [], left: [],
    totals: { kcal, protein, carbs: 60, fat: 20 } });
  const target = { kcal: 600, protein: 40, carbs: 60, fat: 20 };

  it("fits only when every macro is within the slot's bar, and says the miss", () => {
    expect(documentMeal(match(610, 41), "meal-2", target)).toMatchObject({ fitsTarget: true, fitNote: null });
    const over = documentMeal(match(1800, 40), "meal-2", target);
    expect(over.fitsTarget).toBe(false);
    expect(over.fitNote).toMatch(/over on kcal by 1200 kcal/i);
  });

  it("has no bar to miss when the slot has no target", () => {
    expect(documentMeal(match(1800, 90), "meal-2", undefined).fitsTarget).toBe(true);
  });
});
