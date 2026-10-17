import { describe, expect, it } from "vitest";
import { dbFood, FOOD_DB, gramsForDbPortion, loggedFoodFor, logPortionsFor, macrosForGrams, macrosForPortion, mineAsDb,
  portionsFor, searchFoods } from "./food-db";
import { rowServingLine, servingOf, servingOfDbFood } from "./catalog/serving";
import type { Food } from "./foods";
import { resolveDay } from "./resolve";
import { defaultSettings } from "./store";
import type { Store } from "./types";

const chicken: Food = { id: "chicken", name: "Chicken breast, roasted", role: "protein",
  unit: "oz", perUnit: { protein: 8.8, carbs: 0, fat: 1 }, status: "eats",
  updatedAt: "2026-09-20T00:00:00.000Z" };

describe("food database", () => {
  it("has ~500 foods with sane per-100g values", () => {
    expect(FOOD_DB.length).toBeGreaterThanOrEqual(450);
    for (const f of FOOD_DB) {
      expect(f.per100g.kcal, f.name).toBeGreaterThanOrEqual(0);
      expect(f.per100g.kcal, f.name).toBeLessThanOrEqual(910); // pure fat is ~900
      expect(f.per100g.protein + f.per100g.carbs + f.per100g.fat, f.name).toBeLessThanOrEqual(101);
      expect(f.portions.length, f.name).toBeGreaterThan(0);
    }
    expect(new Set(FOOD_DB.map((f) => f.id)).size).toBe(FOOD_DB.length);
  });

  it("matches USDA reference values", () => {
    expect(dbFood("chicken-breast-roasted")!.per100g).toMatchObject({ kcal: 165, protein: 31 });
    expect(dbFood("banana")!.per100g).toMatchObject({ kcal: 89, carbs: 22.8 });
    expect(dbFood("olive-oil")!.per100g).toMatchObject({ kcal: 884, fat: 100 });
  });

  it("scales macros by grams and rounds to a phone screen", () => {
    const egg = dbFood("egg-whole-large")!;
    const one = macrosForGrams(egg, 50);
    expect(one.kcal).toBe(72);
    expect(one.protein).toBe(6.3);
    const two = macrosForGrams(egg, 100);
    expect(two.protein).toBe(12.6);
  });

  it("lists gluten, dairy and apple foods with no default off-plan mark", () => {
    // The JSON's legacy `flags` were the original client's plan. No account inherits them: what a
    // food breaks for an account comes from that account's rules (server verdict, log commit).
    for (const id of ["white-bread", "cheddar-cheese", "apple-with-skin", "greek-yogurt-plain-nonfat"]) {
      const food = dbFood(id);
      if (!food) continue;
      expect(food).not.toHaveProperty("flags");
    }
    for (const f of FOOD_DB) expect(f, f.id).not.toHaveProperty("flags");
    const hits = searchFoods("bread", {});
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h).not.toHaveProperty("flags");
  });

  it("always offers 1 oz and 100 g portions, and everyday portions first", () => {
    const p = portionsFor(dbFood("banana")!).map((x) => x.label);
    expect(p).toContain("1 oz");
    expect(p).toContain("100 g");
    expect(p[0]).toMatch(/medium/);
    expect(portionsFor(dbFood("egg-whole-large")!)[0].label).toMatch(/medium|large/);
    expect(portionsFor(dbFood("olive-oil")!)[0].label).toMatch(/tablespoon|tbsp/);
  });
});

describe("searchFoods", () => {
  it("finds by prefix and ranks exact words first", () => {
    const hits = searchFoods("banana");
    expect(hits[0].name.toLowerCase().startsWith("banana")).toBe(true);
  });

  it("tolerates missing letters", () => {
    const hits = searchFoods("chkn brst");
    expect(hits.some((h) => /chicken breast/i.test(h.name))).toBe(true);
  });

  it("puts account foods first on a tie", () => {
    const rice = { ...chicken, id: "rice", name: "White rice", role: "carb" as const,
      unit: "cup" as const, perUnit: { protein: 4.3, carbs: 44.5, fat: 0.4 } };
    const hits = searchFoods("white rice", { rice });
    expect(hits[0].source).toBe("mine");
  });

  it("returns nothing for an empty query", () => {
    expect(searchFoods("   ")).toEqual([]);
  });

  it("matches a plain plural query against singular USDA names", () => {
    const hits = searchFoods("eggs");
    expect(hits.some((h) => h.id === "egg-whole-large")).toBe(true);
  });

  it("carries serving data on every hit, in the UI lane's shape, with a null id for its own portions", () => {
    const hits = searchFoods("banana");
    const hit = hits[0];
    expect(typeof hit.kcalPer100g).toBe("number");
    expect(hit.per100g).toMatchObject({ kcal: hit.kcalPer100g });
    expect(hit.portions.length).toBeGreaterThan(0);
    expect(hit.portions.every((p) => p.id === null)).toBe(true);
    // Always a synthetic 100 g tail, last.
    expect(hit.portions[hit.portions.length - 1]).toEqual(
      { id: null, label: "100 g", grams: 100, kcal: hit.kcalPer100g });
    expect(hit.defaultPortion).toEqual(hit.portions[0]);
  });

  it("carries serving data for an account's own ('mine') food too", () => {
    // A name the food list knows, so its cup has a real weight (158 g), not a flat 240 g.
    const rice = { ...chicken, id: "rice", name: "White rice, cooked", role: "carb" as const,
      unit: "cup" as const, perUnit: { protein: 4.3, carbs: 44.5, fat: 0.4 } };
    const hits = searchFoods("white rice", { rice });
    const mine = hits.find((h) => h.source === "mine")!;
    expect(mine.defaultPortion).not.toBeNull();
    expect(mine.defaultPortion?.id).toBeNull();
    expect(mine.defaultPortion?.grams).toBe(158);
    expect(mine.per100g?.carbs).toBeCloseTo((44.5 / 158) * 100, 5);
  });
});

describe("logged extras", () => {
  it("count toward the day's consumed macros", () => {
    const store: Store = {
      version: 1,
      firstOpenedAt: "2026-08-01T12:00:00.000Z",
      settings: defaultSettings(),
      foods: {},
      days: {
        "2026-09-07": {
          date: "2026-09-07",
          extras: [
            { id: "x1", foodId: "banana", name: "Banana", portionLabel: "1 medium", qty: 1, grams: 118, macros: macrosForGrams(dbFood("banana")!, 118), at: "2026-09-07T10:00:00.000Z" },
          ],
        },
      },
    };
    const day = resolveDay(store, "2026-09-07");
    expect(day.extras.length).toBe(1);
    expect(day.consumed.kcal).toBe(105);
    expect(day.consumed.carbs).toBe(27);
  });

  it("converts account foods to the per-100g shape", () => {
    const db = mineAsDb(chicken);
    expect(Math.round(db.per100g.protein)).toBe(31);
  });

  it("marks no account food off-plan by its name alone (audit finding #28 reversed)", () => {
    const cheesyFood: Food = { id: "custom-cheddar-cheese", name: "Cheddar cheese", role: "fat", unit: "oz",
      perUnit: { protein: 7, carbs: 0.4, fat: 9.3 }, status: "eats", updatedAt: "2026-09-13T00:00:00.000Z" };
    expect(mineAsDb(cheesyFood)).not.toHaveProperty("flags");
    const hit = searchFoods("cheddar", { [cheesyFood.id]: cheesyFood }).find((h) => h.id === cheesyFood.id);
    expect(hit).toBeDefined();
    expect(hit).not.toHaveProperty("flags");
  });
});

describe("mineAsDb — the account food's real unit weight (audit N2)", () => {
  const banana: Food = { id: "banana-mine", name: "Banana", role: "carb", unit: "whole",
    perUnit: { protein: 1.3, carbs: 26.9, fat: 0.4 }, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" };
  const perUnitKcal = 1.3 * 4 + 26.9 * 4 + 0.4 * 9;

  it("converts a banana by its 118 g weight, not a flat 100 g", () => {
    const db = mineAsDb(banana);
    expect(db.servingOnly).toBeUndefined();
    expect(db.portions).toEqual([{ label: "1 each", grams: 118 }]);
    expect(db.per100g.kcal).toBeCloseTo((perUnitKcal / 118) * 100, 5);
    expect(db.per100g.carbs).toBeCloseTo((26.9 / 118) * 100, 5);
  });

  it("offers distinct, correctly weighted portions, and one each logs the entered macros", () => {
    const db = mineAsDb(banana);
    const portions = portionsFor(db);
    expect(portions.map((p) => p.label)).toEqual(["1 each", "1 oz", "100 g"]);
    expect(new Set(portions.map((p) => p.grams)).size).toBe(3);
    expect(macrosForGrams(db, 118)).toEqual({ protein: 1.3, carbs: 26.9, fat: 0.4, kcal: Math.round(perUnitKcal) });
    expect(macrosForGrams(db, 100).kcal).toBe(Math.round((perUnitKcal / 118) * 100));
  });

  it("weighs a millilitre food by its density: 15 ml of olive oil is about 13.8 g", () => {
    const oil: Food = { id: "oil", name: "Olive oil", role: "fat", unit: "ml",
      perUnit: { protein: 0, carbs: 0, fat: 0.92 }, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" };
    const db = mineAsDb(oil);
    expect(db.servingOnly).toBeUndefined();
    expect(db.portions[0].grams).toBeCloseTo(0.92, 5);
    expect(15 * db.portions[0].grams).toBeCloseTo(13.8, 1);
    // 0.92 g fat per ml over 0.92 g per ml is 100 g fat per 100 g.
    expect(db.per100g.fat).toBeCloseTo(100, 5);
  });

  it("prefers a curated starter's own weight over the food list (Greek yogurt cup is 245 g)", () => {
    const yogurt: Food = { id: "y", name: "Greek yogurt, plain nonfat", role: "protein", unit: "cup",
      perUnit: { protein: 24.5, carbs: 8.8, fat: 0.9 }, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" };
    const db = mineAsDb(yogurt);
    expect(db.servingOnly).toBeUndefined();
    expect(db.portions[0].grams).toBe(245);
  });

  const stew: Food = { id: "stew", name: "Grandma's stew", role: "protein", unit: "cup",
    perUnit: { protein: 20, carbs: 15, fat: 8 }, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" };
  const stewKcal = 20 * 4 + 15 * 4 + 8 * 9; // 212
  const tonic: Food = { id: "tonic", name: "Grandma's tonic", role: "carb", unit: "ml",
    perUnit: { protein: 0, carbs: 0.1, fat: 0 }, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" };

  // Round 3: the older callers (components/LogFoodSheet.tsx buildEntry, app/page.tsx logFromLabel,
  // searchFoods, lib/catalog/serving.ts) see an unknown-weight food exactly as origin/main did.
  it("leaves an unknown-weight food on the older paths exactly as before (stand-in weight, no throw)", () => {
    const db = mineAsDb(stew);
    expect(db.portions).toEqual([{ label: "1 cup", grams: 240 }]);
    expect(portionsFor(db).map((p) => p.label)).toEqual(["1 cup", "1 oz", "100 g"]);
    expect(db.per100g.fiber).toBe(0);
    // The sheet's formula, macrosForGrams(food, portion.grams × qty), logs the entered macros.
    for (const qty of [0.25, 1, 2.5]) {
      const grams = Math.round(db.portions[0].grams * qty * 10) / 10;
      expect(macrosForGrams(db, grams)).toEqual(macrosForPortion(db, db.portions[0], qty));
    }
    expect(macrosForGrams(db, db.portions[0].grams)).toEqual({ protein: 20, carbs: 15, fat: 8, kcal: stewKcal });
    // Search and the serving reader: the same shape as before, so the row keeps its serving line.
    const hit = searchFoods("grandma stew", { [stew.id]: stew }).find((h) => h.id === stew.id)!;
    expect(hit.defaultPortion).toMatchObject({ label: "1 cup", grams: 240, kcal: stewKcal });
    expect(servingOf(hit).defaultPortion).toMatchObject({ label: "1 cup", kcal: stewKcal });
    expect(servingOfDbFood(db).defaultPortion).toMatchObject({ label: "1 cup", kcal: stewKcal });
    // A liquid of unknown density keeps the old 1 g per ml stand-in and its 100 ml line.
    const tonicDb = mineAsDb(tonic);
    expect(tonicDb.portions).toEqual([{ label: "1 ml", grams: 1 }]);
    expect(macrosForGrams(tonicDb, 250)).toMatchObject({ carbs: 25, kcal: 100 });
    expect(rowServingLine({ offline: true, offlineSource: "mine", offlineFoodId: "tonic" }, { tonic }))
      .toBe("100 ml · 40 kcal");
  });

  it("marks an unknown-weight food servingOnly, with its entered macros, for the opt-in helpers", () => {
    const db = mineAsDb(stew);
    expect(db.servingOnly).toBe(true);
    expect(db.perServing).toEqual({ protein: 20, carbs: 15, fat: 8, kcal: stewKcal });
    expect(macrosForPortion(db, db.portions[0], 1.5)).toEqual({ protein: 30, carbs: 22.5, fat: 12, kcal: 318 });
    expect(gramsForDbPortion(db, db.portions[0], 2)).toBeNull();
    const entry = loggedFoodFor(db, db.portions[0], 2, { id: "e1", at: "2026-10-05T12:00:00.000Z" });
    // grams 0 = weight unknown: the stand-in 240 is never recorded as a mass.
    expect(entry).toMatchObject({ portionLabel: "1 cup", qty: 2, grams: 0,
      macros: { protein: 40, carbs: 30, fat: 16, kcal: 424 } });
    const tonicEntry = loggedFoodFor(mineAsDb(tonic), mineAsDb(tonic).portions[0], 250,
      { id: "e3", at: "2026-10-05T12:00:00.000Z" });
    expect(tonicEntry).toMatchObject({ grams: 0, macros: { carbs: 25, kcal: 100 } });
  });

  it("refuses a gram portion of a servingOnly food in the opt-in helpers: 100 g of it is not an amount", () => {
    const db = mineAsDb(stew);
    const hundred = portionsFor(db).find((p) => p.label === "100 g")!;
    expect(() => macrosForPortion(db, hundred, 1)).toThrow(/no known weight/);
    expect(() => gramsForDbPortion(db, hundred, 1)).toThrow(/no known weight/);
  });

  // Grok round 4, BLOCK 1: a density is never rounded before it is scaled.
  describe("a liquid's density at full precision, rounded once at the end", () => {
    const oil: Food = { id: "oil", name: "Olive oil", role: "fat", unit: "ml",
      perUnit: { protein: 0, carbs: 0, fat: 0.92 }, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" };
    const milk: Food = { id: "milk", name: "Milk, whole", role: "carb", unit: "ml",
      perUnit: { protein: 0.0315, carbs: 0.048, fat: 0.0325 }, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" };
    const at = "2026-10-05T12:00:00.000Z";
    const exact = (f: Food, ml: number) => ({
      protein: Math.round(f.perUnit.protein * ml * 10) / 10, carbs: Math.round(f.perUnit.carbs * ml * 10) / 10,
      fat: Math.round(f.perUnit.fat * ml * 10) / 10,
      kcal: Math.round((f.perUnit.protein * 4 + f.perUnit.carbs * 4 + f.perUnit.fat * 9) * ml),
    });

    it("1 ml of olive oil: 0.92 g, 8 kcal (the entered 8.28), not 0.9 g and 7 kcal", () => {
      const db = mineAsDb(oil);
      expect(db.portions[0].grams).toBe(0.92);
      expect(macrosForPortion(db, db.portions[0], 1)).toEqual(exact(oil, 1));
      expect(macrosForPortion(db, db.portions[0], 1).kcal).toBe(8);
      expect(loggedFoodFor(db, db.portions[0], 1, { id: "o1", at }).grams).toBe(0.92);
      expect(gramsForDbPortion(db, db.portions[0], 1)).toBe(0.92);
    });

    it("15 ml of olive oil: 13.8 g fat, 124 kcal", () => {
      const db = mineAsDb(oil);
      expect(macrosForPortion(db, db.portions[0], 15)).toEqual({ protein: 0, carbs: 0, fat: 13.8, kcal: 124 });
      expect(gramsForDbPortion(db, db.portions[0], 15)).toBe(13.8);
    });

    it("250 ml of whole milk: 257.5 g and exactly 250 × the entered macros", () => {
      const db = mineAsDb(milk);
      expect(db.portions[0].grams).toBe(1.03);
      expect(gramsForDbPortion(db, db.portions[0], 250)).toBe(257.5);
      expect(macrosForPortion(db, db.portions[0], 250)).toEqual(exact(milk, 250));
      for (const ml of [1, 3, 7, 33]) expect(macrosForPortion(db, db.portions[0], ml)).toEqual(exact(milk, ml));
      // The card's mass is the same product, rounded once: 1 ml of milk is 1.03 g, not 1.0.
      expect(gramsForDbPortion(db, db.portions[0], 1)).toBe(1.03);
      expect(gramsForDbPortion(db, db.portions[0], 3)).toBe(3.09);
    });
  });

  it("gives new code a weight-unknown portion and marks the search hit serving-only", () => {
    const db = mineAsDb(stew);
    expect(logPortionsFor(db)).toEqual([{ label: "1 cup", grams: 0 }]);
    expect(loggedFoodFor(db, logPortionsFor(db)[0], 1, { id: "s", at: "2026-10-05T12:00:00.000Z" }))
      .toMatchObject({ grams: 0, macros: { protein: 20, carbs: 15, fat: 8, kcal: stewKcal } });
    const hit = searchFoods("grandma stew", { [stew.id]: stew }).find((h) => h.id === stew.id)!;
    expect(hit).toMatchObject({ servingOnly: true, perServing: { protein: 20, carbs: 15, fat: 8, kcal: stewKcal } });
    const weighed = searchFoods("white rice", { r: { ...stew, id: "r", name: "White rice, cooked", role: "carb" } })
      .find((h) => h.id === "r")!;
    expect(weighed.servingOnly).toBeUndefined();
  });

  it("logs a weighed food through its grams, the same numbers as before", () => {
    const banana: Food = { id: "b", name: "Banana", role: "carb", unit: "whole",
      perUnit: { protein: 1.3, carbs: 26.9, fat: 0.4 }, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" };
    const db = mineAsDb(banana);
    const entry = loggedFoodFor(db, db.portions[0], 2, { id: "e2", at: "2026-10-05T12:00:00.000Z" });
    expect(entry.grams).toBe(236);
    expect(entry.macros).toEqual(macrosForGrams(db, 236));
  });
});
