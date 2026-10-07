/**
 * Grok round 5, BLOCK 1: one weight for one of an account food's units. The logger (`mineAsDb`), the
 * `user_foods.per_100g` writer (`per100gFor`), the Foods page base (`unitGrams`), meal parts
 * (`gramsOf`) and the starter attestation all read `accountUnitGrams`, starter weight first.
 */
import { describe, expect, it } from "vitest";
import { mineAsDb } from "@/lib/food-db";
import type { Food, FoodUnit } from "@/lib/foods";
import { per100Base, unitGrams } from "@/lib/foods/display";
import { per100gFor } from "@/lib/foods/prefs-client";
import { STARTERS, starterFood } from "@/lib/foods/starter";
import { accountUnitGrams, firstRealWeight } from "@/lib/foods/unit-grams";
import { unitGramsOf } from "@/lib/log/picked-commit";
import { gramsOf } from "@/lib/meals/parts";
import { perUnitTo100g } from "@/lib/units";

const own = (name: string, unit: FoodUnit, perUnit: Food["perUnit"] = { protein: 5, carbs: 10, fat: 2 }): Food =>
  ({ id: name, name, role: "carb", unit, perUnit, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" });

const foods: Food[] = [
  ...STARTERS.map((item) => starterFood(item.id, "eats")),
  own("Avocado", "whole"), own("Peanut butter", "tsp"), own("Olive oil", "ml"), own("Milk, whole", "ml"),
  own("Grandma's stew", "cup"), own("Grandma's tonic", "ml"), own("Mystery bar", "whole"),
];

describe("accountUnitGrams — every reader agrees", () => {
  it("puts the curated starter weight first (yogurt cup 245 g, banana 118 g)", () => {
    expect(accountUnitGrams({ name: "Greek yogurt, plain nonfat", unit: "cup" })).toBe(245);
    expect(accountUnitGrams({ name: "Banana", unit: "whole" })).toBe(118);
  });

  it.each(foods.map((food) => [food.name, food.unit, food] as const))("%s (%s)", (_name, _unit, food) => {
    const grams = accountUnitGrams(food);
    expect(per100gFor(food)).toEqual(grams === null ? {} : perUnitTo100g(food.perUnit, grams));
    expect(gramsOf(food)).toBe(grams);
    if (food.unit !== "g" && food.unit !== "ml") expect(unitGrams(food)).toBe(grams);
    // The Foods page states an ml food per 100 ml, a volume base computed from the entered per-ml
    // figures; it never claims a gram weight, so it cannot disagree with the stored per-100 g.
    if (food.unit === "ml") expect(per100Base(food).label).toBe("100 ml");
    const db = mineAsDb(food);
    if (grams === null) expect(db.servingOnly).toBe(true);
    else expect(db.portions[0].grams).toBe(grams);
  });

  it("the log writer (picked-commit) weighs one unit the same way", () => {
    for (const food of foods) expect([food.name, unitGramsOf(food)]).toEqual([food.name, accountUnitGrams(food)]);
  });

  it("a starter's per_100g is the food list's own per-100 g figure", () => {
    const banana = starterFood("banana", "eats");
    expect(mineAsDb(banana).per100g.carbs).toBeCloseTo(per100gFor(banana).carbohydrate!, 1);
  });
});

describe("firstRealWeight", () => {
  it("lets a broken weight (0, NaN, negative) fall through to the next real one", () => {
    expect(firstRealWeight(0, 81)).toBe(81);
    expect(firstRealWeight(Number.NaN, null, -3, 118)).toBe(118);
    expect(firstRealWeight(null, undefined, 0)).toBeNull();
    expect(firstRealWeight(118, 81)).toBe(118);
  });
});
