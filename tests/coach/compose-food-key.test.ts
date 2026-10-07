/**
 * Phase 18 W6 UI-NEEDS 1: a coach-composed meal's items carry their food's wire key
 * (`food:<user_foods.id>` or `catalog:<catalog_foods.id>`, lib/meals/food-key.ts), so the Plan
 * sheet and the suggestion cards can name the food a tap was about in a signal event. The key comes
 * from the search hit (the account's own food, or the catalog mapper), survives sizing and the
 * template builder, and survives the stored-block schema; a malformed key is dropped, never fatal.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import { composeMeal, itemFoodKey } from "@/lib/coach/compose";
import { composeTemplateMeal } from "@/lib/coach/compose-template";
import type { FoodHit } from "@/lib/coach/executors";
import { composedMealSchema } from "@/lib/coach/ui-blocks";
import { renderToolResult } from "@/lib/coach/envelope";
import { isFoodKey } from "@/lib/meals/food-key";
import { mapCatalogFoodHit } from "@/lib/server/coach";
import type { FoodDetail, FoodSearchHit } from "@/lib/server/catalog";
import { F, FIVE_MEAL, OPEN_PROFILE, searchOver } from "@/tests/coach/meal-template-fixtures";

const OWN = "food:6f1d0c1e-4a52-4c39-9a8e-3b2c1d0e9f12";
const TARGET = { kcal: 700, protein: 45, carbs: 70, fat: 22 };

const hit = (over: Partial<FoodHit>): FoodHit => ({
  foodRefId: "3f1b1a2c-0000-4000-8000-000000000001", name: "Chicken breast, roasted", brand: null,
  kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6, prefStatus: "eats",
  catalogFoodRevisionId: 11, allergenTags: [], category: null, ...over,
});

describe("itemFoodKey", () => {
  it("copies a well-formed key and drops a missing or malformed one", () => {
    expect(itemFoodKey({ foodKey: "catalog:42" })).toEqual({ foodKey: "catalog:42" });
    expect(itemFoodKey({ foodKey: OWN })).toEqual({ foodKey: OWN });
    expect(itemFoodKey({})).toEqual({});
    expect(itemFoodKey({ foodKey: "Chicken breast" })).toEqual({});
    expect(itemFoodKey({ foodKey: "catalog:0" })).toEqual({});
  });
});

describe("composeMeal carries each hit's food key", () => {
  it("on the named foods and on the complement it adds", async () => {
    const chicken = hit({ foodKey: OWN });
    const rice = hit({ foodRefId: "3f1b1a2c-0000-4000-8000-000000000002", name: "Rice, white, cooked",
      kcalPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3, foodKey: "catalog:7" });
    const oil = hit({ foodRefId: "3f1b1a2c-0000-4000-8000-000000000003", name: "Olive oil",
      kcalPer100g: 884, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 100, foodKey: "catalog:9" });
    const byTerm: Record<string, FoodHit[]> = { chicken: [chicken], rice: [rice], "Olive oil": [oil] };
    const meal = await composeMeal("u1", { wish: "chicken and rice", target: TARGET }, OPEN_PROFILE, {
      searchFoods: vi.fn(async (_u: string, q: string) => byTerm[q] ?? []),
      eatsNames: async () => ["Olive oil"],
    });
    const keys = Object.fromEntries(meal.items.map((item) => [item.name, item.foodKey]));
    expect(keys["Chicken breast, roasted"]).toBe(OWN);
    expect(keys["Rice, white, cooked"]).toBe("catalog:7");
    // Phase 18 W9 (D12): "chicken and rice" already satisfies the main template (anchor +
    // starch), so Olive oil fills the template's OPTIONAL fat part through the same plate
    // search the daily layout uses, not the old per-item `addedFor` complement; its food key
    // still carries (`lib/meals/size.ts`'s `generatedComponent` -> `componentFoodKey`).
    expect(keys["Olive oil"]).toBe("catalog:9");
  });

  it("leaves the field off an item whose hit had no key", async () => {
    const meal = await composeMeal("u1", { wish: "chicken", target: TARGET }, OPEN_PROFILE, {
      searchFoods: vi.fn(async () => [hit({})]),
    });
    expect(meal.items[0]).not.toHaveProperty("foodKey");
  });
});

describe("a suggestion card (template builder) carries the keys too", () => {
  it("every item from a keyed hit keeps its key through sizing", async () => {
    const foods = Object.values(F).map((food, index) => ({ ...food, foodKey: `catalog:${index + 1}` }));
    const meal = await composeTemplateMeal("u1", {
      wish: F.chicken.name, slot: "meal-3", target: FIVE_MEAL, anchorProtein: F.chicken.name,
      mealType: "dinner", mealClock: "19:00", rotation: 0,
    }, OPEN_PROFILE, { searchFoods: searchOver(foods), eatsNames: async () => foods.map((f) => f.name) });
    expect(meal.items.length).toBeGreaterThan(0);
    for (const item of meal.items) expect(isFoodKey(item.foodKey)).toBe(true);
    expect(meal.items[0].foodKey).toBe(foods.find((f) => f.name === meal.items[0].name)?.foodKey);
  });
});

describe("the stored food_ideas / composed-meal schema", () => {
  const item = { name: "Chicken", foodRefId: "r1", catalogFoodRevisionId: 11, grams: 150,
    kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
    macros: { kcal: 248, protein: 47, carbs: 0, fat: 5 }, verdict: "allowed" };
  const meal = (items: unknown[]) => ({ wish: "x", slot: null, items, flagged: [], fitsTarget: true,
    totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, target: { kcal: 0, protein: 0, carbs: 0, fat: 0 } });

  it("keeps a valid key, and drops a malformed one without failing the meal", () => {
    const parsed = composedMealSchema.parse(meal([{ ...item, foodKey: OWN }, { ...item, foodKey: "my notes" },
      { ...item }]));
    expect(parsed.items.map((i) => i.foodKey)).toEqual([OWN, undefined, undefined]);
  });
});

describe("mapCatalogFoodHit", () => {
  it("keys a catalog hit by its catalog food id", () => {
    const detail = { catalogFoodId: 4242, revisionId: 11, per100g: {}, ingredients: [],
      kcalPer100g: 100, allergenEvidence: {}, checkedAllergens: [], ingredientsText: null,
      ingredientsTextIsLabel: false, policyCategories: [], defaultPortion: null } as unknown as FoodDetail;
    const searchHit = { description: "Lentils", brand: null, prefStatus: null, source: "sr_legacy",
      policy: { verdict: "allowed" } } as unknown as FoodSearchHit;
    expect(mapCatalogFoodHit(searchHit, detail, "ref-1").foodKey).toBe("catalog:4242");
    const keyless = { ...detail, catalogFoodId: undefined } as unknown as FoodDetail;
    expect(mapCatalogFoodHit(searchHit, keyless, "ref-1")).not.toHaveProperty("foodKey");
  });
});

describe("the model never sees a food key", () => {
  it("renderToolResult leaves every foodKey out of the transcript copy, at any depth", () => {
    const text = renderToolResult({ name: "search_foods", ok: true, data: { data: {
      hits: [{ name: "Chicken", foodRefId: "r1", foodKey: OWN }],
      meal: { items: [{ name: "Rice", foodKey: "catalog:7" }] },
    } } } as never);
    expect(text).not.toContain("foodKey");
    expect(text).not.toContain(OWN);
    expect(text).toContain("Chicken");
    expect(text).toContain("Rice");
  });
});
