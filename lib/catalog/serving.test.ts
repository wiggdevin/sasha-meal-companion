/**
 * U8: serving-aware food lines. The backend's serving fields are optional everywhere, so every line
 * must read well with them, with only the 100 g figure, and with nothing at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { dbFood } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import {
  bundledFoodNamed, forgetPortions, portionForName, portionPill, rememberPortion, rowServingLine, servingLine, servingOf,
  servingOfDbFood, servingOfFood,
} from "@/lib/catalog/serving";

afterEach(() => { forgetPortions(); unbindAccount(); });

const TBSP = { id: "p1", label: "1 tbsp", grams: 14, kcal: 126 };

describe("servingOf", () => {
  it("reads a search hit's portions, default portion and per-100 g figures", () => {
    const serving = servingOf({ defaultPortion: TBSP, portions: [TBSP, { id: null, label: "100 g", grams: 100, kcal: 900 }],
      kcalPer100g: 900, per100g: { kcal: 900, protein: 0, carbs: 0, fat: 100 } });
    expect(serving.defaultPortion).toEqual(TBSP);
    expect(serving.portions.map((p) => p.label)).toEqual(["1 tbsp", "100 g"]);
    expect(serving.kcalPer100g).toBe(900);
  });

  it("reads a food detail's serving names and ignores its older portion and nutrient shapes", () => {
    const serving = servingOf({
      portions: [{ id: 7, description: "1 tbsp", gramWeight: 14, isDefault: true }],
      per100g: { energy_kcal: { amount: 900, unit: "kcal" } },
      servingPortions: [TBSP], simplePer100g: { kcal: 900, protein: 0, carbs: 0, fat: 100 },
      defaultPortion: TBSP,
    });
    expect(serving.portions).toEqual([TBSP]);
    expect(serving.kcalPer100g).toBe(900);
    expect(servingOf({ portions: [{ id: 7, description: "1 tbsp", gramWeight: 14 }] }).portions).toEqual([]);
  });

  it("treats a missing or malformed field as absent", () => {
    expect(servingOf(undefined)).toEqual({ portions: [], defaultPortion: null, kcalPer100g: null, per100g: null });
    const broken = servingOf({ defaultPortion: { label: "", grams: -1 }, kcalPer100g: Number.NaN, portions: "x" });
    expect(broken.defaultPortion).toBeNull();
    expect(broken.kcalPer100g).toBeNull();
    expect(broken.portions).toEqual([]);
  });
});

describe("servingLine", () => {
  it("names the default portion with its weight and calories", () => {
    expect(servingLine(servingOf({ defaultPortion: TBSP, kcalPer100g: 900 }))).toBe("1 tbsp (14 g) · 126 kcal");
  });

  it("says a written-out household word the short way", () => {
    expect(servingLine(servingOf({ defaultPortion: { id: null, label: "1 tablespoon", grams: 13.5, kcal: 119 } })))
      .toBe("1 tbsp (14 g) · 119 kcal");
    expect(portionPill({ label: "2 teaspoons", grams: 9, kcal: 80 })).toBe("2 tsp · 9 g · 80 kcal");
  });

  it("does not repeat a weight the label already holds", () => {
    expect(servingLine(servingOf({ defaultPortion: { id: null, label: "1 bar (40 g)", grams: 40, kcal: 180 } })))
      .toBe("1 bar (40 g) · 180 kcal");
  });

  it("works the calories out from the 100 g figure when the portion has none", () => {
    expect(servingLine(servingOf({ defaultPortion: { id: null, label: "1 tsp", grams: 4.5, kcal: null }, kcalPer100g: 884 })))
      .toBe("1 tsp (4.5 g) · 40 kcal");
  });

  it("falls back to 100 g when there is no real portion, then to nothing", () => {
    expect(servingLine(servingOf({ defaultPortion: null, kcalPer100g: 900 }))).toBe("100 g · 900 kcal");
    expect(servingLine(servingOf({}))).toBeNull();
  });
});

describe("offline servings", () => {
  it("states a bundled food by its everyday portion, ending in 100 g", () => {
    const butter = servingOfDbFood(dbFood("peanut-butter")!);
    expect(servingLine(butter)).toBe("2 tbsp (32 g) · 191 kcal");
    expect(butter.portions.at(-1)).toMatchObject({ label: "100 g", grams: 100, id: null });
  });

  it("states the account's own food by its unit", () => {
    const food = (over: Partial<Food>): Food => ({ id: "x", name: "Ghee", role: "fat", unit: "tbsp",
      perUnit: { protein: 0, carbs: 0, fat: 14 }, status: "eats", updatedAt: "" , ...over }) as Food;
    expect(servingLine(servingOfFood(food({})))).toMatch(/^1 tbsp( \(\d+(\.\d)? g\))? · 126 kcal$/);
    expect(servingLine(servingOfFood(food({ unit: "g", perUnit: { protein: 0.31, carbs: 0, fat: 0.036 } }))))
      .toBe("100 g · 156 kcal");
    expect(servingLine(servingOfFood(food({ perUnit: { protein: 0, carbs: 0, fat: 0 }, nutritionUnknown: true }))))
      .toBeNull();
  });

  it("states a millilitre food per 100 ml, never 100 g (the Foods page's own base)", () => {
    const milk = { id: "milk", name: "Oat milk", role: "carb", unit: "ml", perUnit: { protein: 0.01, carbs: 0.07, fat: 0.015 },
      status: "eats", updatedAt: "" } as Food;
    const serving = servingOfFood(milk);
    expect(servingLine(serving)).toBe("100 ml · 46 kcal");
    expect(serving.portions).toEqual([{ id: null, label: "100 ml", grams: 100, kcal: 46 }]);
    expect(portionPill(serving.portions[0])).toBe("100 ml · 46 kcal");
    expect(rowServingLine({ offline: true, offlineSource: "mine", offlineFoodId: "milk" }, { milk }))
      .toBe("100 ml · 46 kcal");
  });
});

describe("portionPill", () => {
  it("reads label, weight and calories", () => {
    expect(portionPill(TBSP)).toBe("1 tbsp · 14 g · 126 kcal");
    expect(portionPill({ label: "100 g", grams: 100, kcal: 900 })).toBe("100 g · 900 kcal");
    expect(portionPill({ label: "1 cup", grams: 240, kcal: null })).toBe("1 cup · 240 g");
  });
});

describe("portionForName", () => {
  it("prefers the portion this session added the food with, then the bundled food of that name", () => {
    expect(portionForName("Olive oil")).toMatchObject({ label: "1 tablespoon", grams: 13.5 });
    rememberPortion("Olive oil", { label: "1 tsp", grams: 4.5 });
    expect(portionForName("olive OIL")).toMatchObject({ label: "1 tsp", grams: 4.5 });
    expect(portionForName("Something nobody bundled")).toBeNull();
    expect(bundledFoodNamed("Peanut butter")?.id).toBe("peanut-butter");
  });

  it("never remembers the 100 g tail as a food's portion", () => {
    rememberPortion("Rice", { label: "100 g", grams: 100 });
    expect(portionForName("Rice", () => undefined)).toBeNull();
  });

  it("keeps each account's remembered portions to itself, and forgets them when the account leaves", () => {
    bindAccount("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    rememberPortion("Ghee", { label: "1 tsp", grams: 5 });
    expect(portionForName("Ghee", () => undefined)).toMatchObject({ label: "1 tsp" });
    // Another account in the same tab inherits nothing.
    bindAccount("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(portionForName("Ghee", () => undefined)).toBeNull();
    rememberPortion("Ghee", { label: "1 tbsp", grams: 14 });
    // Signing out clears the memo, so the same account signing back in starts fresh too.
    unbindAccount();
    bindAccount("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(portionForName("Ghee", () => undefined)).toBeNull();
  });
});

describe("rowServingLine", () => {
  it("uses the row's own serving fields when the backend sent them", () => {
    expect(rowServingLine({ offline: false, defaultPortion: TBSP, kcalPer100g: 900 } as never))
      .toBe("1 tbsp (14 g) · 126 kcal");
  });

  it("finds an offline row's serving in the bundled foods or the account's own foods", () => {
    expect(rowServingLine({ offline: true, offlineSource: "db", offlineFoodId: "peanut-butter" }))
      .toBe("2 tbsp (32 g) · 191 kcal");
    const ghee = { id: "ghee", name: "Ghee", role: "fat", unit: "g", perUnit: { protein: 0, carbs: 0, fat: 1 },
      status: "eats", updatedAt: "" } as Food;
    expect(rowServingLine({ offline: true, offlineSource: "mine", offlineFoodId: "ghee" }, { ghee }))
      .toBe("100 g · 900 kcal");
  });

  it("is null for an online row without serving data, so the row keeps its own text", () => {
    expect(rowServingLine({ offline: false })).toBeNull();
    expect(rowServingLine({ offline: true, offlineSource: "db", offlineFoodId: "missing" })).toBeNull();
  });
});
