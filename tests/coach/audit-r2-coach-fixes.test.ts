/**
 * 2026-10-04 re-audit r2 (coach slice) on the meal builder:
 * - a whole-egg count never moves protein away from its target when the protein range sits
 *   between two counts (#1), and only whole-unit bands are frozen, not milk (#7);
 * - "no blueberries", "no berries", "don't eat bananas" refuse those foods (#2, #8);
 * - an unknown slot time is not a dinner: scallops do not lead a meal that may be breakfast (#3);
 * - the complement step looks past a catalog twin to the account's own Eats row (#6).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import type { ComposedItem, ComposedMeal } from "@/lib/coach/compose";
import { pickComplement } from "@/lib/coach/compose";
import { fitsTarget, macrosFor, type MealMacros } from "@/lib/coach/compose-size";
import {
  bandOf, fitNamedMealPortions, isUnitCount, sizeWithinBands, stepTowardAim,
} from "@/lib/coach/fit-portions";
import { anchorSuitability } from "@/lib/coach/meal-pairings";
import { isUntimed, mealTypeAt, templateOf } from "@/lib/coach/meal-type";
import { portionBand } from "@/lib/coach/portion-bands";
import { orderAnchors } from "@/lib/coach/suggest-anchors";
import { refusedBy, splitWish, stem } from "@/lib/coach/wish-negation";
import type { FoodHit } from "@/lib/coach/executors";
import { F, OPEN_PROFILE, food } from "@/tests/coach/meal-template-fixtures";

function item(hit: FoodHit, grams: number, part?: ComposedItem["part"]): ComposedItem {
  return { name: hit.name, foodRefId: hit.foodRefId!, catalogFoodRevisionId: null, grams,
    kcalPer100g: hit.kcalPer100g, proteinPer100g: hit.proteinPer100g ?? null,
    carbsPer100g: hit.carbsPer100g ?? null, fatPer100g: hit.fatPer100g ?? null,
    macros: macrosFor(hit, grams), verdict: "allowed", ...(part ? { part } : {}) };
}

function meal(items: ComposedItem[], target: MealMacros): ComposedMeal {
  const totals = items.reduce((sum, row) => ({ kcal: sum.kcal + row.macros.kcal,
    protein: sum.protein + row.macros.protein, carbs: sum.carbs + row.macros.carbs,
    fat: sum.fat + row.macros.fat }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  return { wish: "x", slot: "meal-1", items, totals, target, flagged: [],
    fitsTarget: fitsTarget(totals, target), fitNote: null };
}

describe("whole eggs between two counts (r2 #1)", () => {
  const eggs = portionBand("Eggs, whole, cooked", "anchor");

  it("picks the count toward the protein target, never one that moves protein away", () => {
    // Protein range 110–140 g of egg, from 110 g toward 140 g: 100 g would cut protein.
    expect(stepTowardAim(115, 110, 140, eggs, { from: 110, aim: 140 })).toBe(150);
    // From 140 g down toward 110 g: 150 g would add protein.
    expect(stepTowardAim(135, 110, 140, eggs, { from: 140, aim: 110 })).toBe(100);
  });

  it("sizes the eggs up, not down, when the plate needs more protein than the start", () => {
    const items = [item(F.eggs, 0, "anchor"), item(F.toast, 0, "starch")];
    // Calories pull the eggs to the low end of their protein range (110 g); protein wants ~140 g.
    const target = { kcal: 260, protein: 140 * 0.126 + 0.4 * 12.4, carbs: 20, fat: 12 };
    const sized = sizeWithinBands(items, target, [110, 40]);
    expect(sized[0].grams % 50).toBe(0);
    expect(sized[0].grams).toBeGreaterThanOrEqual(150);
  });
});

describe("only whole-unit bands are held (r2 #7)", () => {
  const milk = food("Milk, reduced fat, 2%", [50, 3.3, 4.8, 2]);

  it("holds eggs, not milk or egg whites", () => {
    expect(isUnitCount(bandOf(item(F.eggs, 100, "anchor")))).toBe(true);
    expect(isUnitCount(bandOf(item(milk, 250)))).toBe(false);
    expect(isUnitCount(portionBand("Egg whites", "anchor"))).toBe(false);
  });

  it("moves a named meal's milk off its composed grams to fit", () => {
    const target = { kcal: 110, protein: 7.3, carbs: 10.6, fat: 4.4 };
    const fitted = fitNamedMealPortions(meal([item(milk, 250)], target));
    expect(fitted.fitsTarget).toBe(true);
    expect(fitted.items[0].grams).toBeLessThan(250);
  });
});

describe("a wish's no reaches plurals and don't (r2 #2, #8)", () => {
  it("stems berry plurals and -oes, and keeps apple whole", () => {
    expect(stem("blueberries")).toBe("blueberry");
    expect(stem("tomatoes")).toBe("tomato");
    expect(stem("apples")).toBe("apple");
    expect(stem("bass")).toBe("bass");
    expect(stem("pies")).toBe("pie");
  });

  it("refuses the berry in either number, and every berry for 'no berries'", () => {
    expect(refusedBy("Blueberries, raw", splitWish("yogurt, no blueberry").negated)).toBe(true);
    expect(refusedBy("Blueberry, raw", splitWish("yogurt, no blueberries").negated)).toBe(true);
    expect(refusedBy("Blueberries, raw", splitWish("no berries").negated)).toBe(true);
    expect(refusedBy("Strawberries, raw", splitWish("no berries").negated)).toBe(true);
    expect(refusedBy("Apple, raw", splitWish("no apples").negated)).toBe(true);
    expect(refusedBy("Graham crackers", splitWish("no ham").negated)).toBe(false);
  });

  it("reads don't and dont as a no", () => {
    const wish = splitWish("salmon dinner, don't want bananas");
    expect(refusedBy("Banana, raw", wish.negated)).toBe(true);
    expect(wish.positive).not.toContain("banana");
    expect(refusedBy("Eggs, whole", splitWish("dont eat eggs").negated)).toBe(true);
    expect(refusedBy("Chicken breast", splitWish("do not add chicken").negated)).toBe(true);
  });
});

describe("an unknown slot time is not a dinner (r2 #3)", () => {
  it("tells unknown from overnight", () => {
    expect(isUntimed(mealTypeAt(null), null)).toBe(true);
    expect(isUntimed(mealTypeAt("23:30"), "23:30")).toBe(false);
  });

  it("puts a food that suits any meal ahead of scallops", () => {
    expect(anchorSuitability(F.scallopsBay.name, "other", null, true)).toBe(1);
    expect(anchorSuitability(F.eggs.name, "other", null, true)).toBe(2);
    expect(orderAnchors([F.scallopsBay.name, F.scallopsSea.name, F.eggs.name], "other", null, true)[0])
      .toBe(F.eggs.name);
    // The wish still wins: "scallops" asked for leads.
    expect(anchorSuitability(F.scallopsBay.name, "other", "scallops please", true)).toBe(2);
  });

  it("builds an untimed egg meal on the breakfast plate, and an overnight one on the main plate", () => {
    expect(templateOf("other", true, ["breakfast", "lunch", "snack"])).toBe("breakfast");
    expect(templateOf("other", true, ["lunch", "dinner"])).toBe("main");
    expect(templateOf("other")).toBe("main");
  });
});

describe("the complement sees the Eats row behind a catalog twin (r2 #6)", () => {
  it("searches more than one hit and keeps the Eats row", async () => {
    const twin = food(F.rice.name, [130, 2.7, 28, 0.3], { prefStatus: null });
    const searchFoods = vi.fn(async (_u: string, query: string, limit: number) =>
      (query === F.rice.name ? [twin, F.rice] : []).slice(0, limit));
    const hit = await pickComplement("u1", "carbs", [F.rice.name], new Set(), new Set(["protein"]),
      OPEN_PROFILE, { searchFoods } as never, true);
    expect(hit?.foodRefId).toBe(F.rice.foodRefId);
    expect(searchFoods.mock.calls[0][2]).toBeGreaterThan(1);
  });
});
