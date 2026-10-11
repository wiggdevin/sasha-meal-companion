/**
 * W004 (audit 2026-10-10, A156): an account (Favored/Eats) food logs the energy its source measured
 * — reported, else calculated (lib/nutrients/energy.ts) — not 4 P + 4 C + 9 F from its macros. A
 * drink's alcohol energy is in no macro: bundled "Red wine" is 85 kcal per 100 g, and its macros
 * (0.1 g protein, 2.6 g carbs) give about 11. The same glass logged from the bundled list and from
 * the user's own foods must store the same energy.
 */
import { describe, expect, it } from "vitest";
import { servingOfFood } from "@/lib/catalog/serving";
import { dbFood, mineAsDb } from "@/lib/food-db";
import { foodKcalPerUnit, omitUnmeasured, withPerUnit, type Food } from "@/lib/foods";
import { per100gFromBundled } from "@/lib/foods/adopt-client";
import { kcalPer100Label } from "@/lib/foods/display";
import { accountPer100g, accountPerUnit, sheetPreview } from "@/lib/log/picked-commit";
import { foodsFromSyncRows } from "@/lib/store";
import { perUnitTo100g } from "@/lib/units";

const AT = "2026-11-02T17:00:00.000Z";
const WINE_ID = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF_ID = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The user's own "Red wine", as the phone builds it from the row the bundled adoption stored. */
function syncedWine(): Food {
  const source = dbFood("red-wine");
  if (!source) throw new Error("red-wine is missing from the bundled list");
  const foods = foodsFromSyncRows(
    [{ id: WINE_ID, name: source.name, per_100g: per100gFromBundled(source), deleted_at: null }],
    [{ food_ref_id: REF_ID, status: "eats", role: "carb", updated_at: AT }],
    [{ id: REF_ID, user_food_id: WINE_ID }]);
  return foods[WINE_ID];
}

function accountPick(food: Food, grams: number) {
  return { source: "account" as const, food, card: { id: "wine-glass", foodId: food.id,
    name: food.name, portionLabel: `${grams} g`, qty: grams, grams,
    macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, at: AT } };
}

describe("account food energy (alcohol)", () => {
  it("keeps the measured energy when the food is read back from its stored row", () => {
    const wine = syncedWine();
    expect(wine.kcalPerUnit).toBeCloseTo(0.85, 10);
    expect(foodKcalPerUnit(wine)).toBeCloseTo(0.85, 10);
  });

  it("logs 85 kcal per 100 g, not the 4/4/9 figure from its macros", () => {
    const basis = accountPer100g(syncedWine());
    expect(basis?.per100g.energy_kcal).toBe(85);
    expect(accountPerUnit(syncedWine())?.energy_kcal).toBe(0.85);
  });

  it("stores the same 150 g glass as the bundled pick does (about 128 kcal, not 16)", () => {
    const preview = sheetPreview(accountPick(syncedWine(), 150));
    expect(preview.macros.kcal).toBe(128);
    const bundled = sheetPreview({ source: "bundled", card: { id: "b-glass", foodId: "red-wine",
      name: "Red wine", portionLabel: "150 g", qty: 1, grams: 150,
      macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, at: AT } });
    expect(bundled.macros.kcal).toBe(preview.macros.kcal);
  });

  it("falls back to 4/4/9 only for a food with no measured energy", () => {
    const typed: Food = { id: "pasta", name: "Pasta", role: "carb", unit: "g",
      perUnit: { protein: 0.05, carbs: 0.3, fat: 0.01 }, status: "eats", updatedAt: AT };
    expect(accountPer100g(typed)?.per100g.energy_kcal).toBe(149);
  });

  it("drops the measured energy once the user edits the macros", () => {
    const wine = syncedWine();
    const edited = withPerUnit(wine, { ...wine.perUnit, carbs: 0.05 });
    expect(edited.kcalPerUnit).toBeUndefined();
    expect(withPerUnit(wine, { ...wine.perUnit }).kcalPerUnit).toBeCloseTo(0.85, 10);
  });

  it("writes the measured energy into a per-100 g row built from per-unit numbers", () => {
    const wine = syncedWine();
    expect(perUnitTo100g(wine.perUnit, 1, wine.kcalPerUnit).energy_kcal).toBe(85);
    expect(perUnitTo100g(wine.perUnit, 1).energy_kcal).toBe(Math.round(0.1 * 4 + 2.6 * 4));
  });

  it("ignores a stored 0 kcal that contradicts the stored macros (rows written before W004)", () => {
    const foods = foodsFromSyncRows(
      [{ id: WINE_ID, name: "Chicken, breast", deleted_at: null,
        per_100g: { energy_kcal: 0, protein: 22.5, carbohydrate: 0, fat_total: 2.6 } }],
      [{ food_ref_id: REF_ID, status: "eats", role: "protein", updated_at: AT }],
      [{ id: REF_ID, user_food_id: WINE_ID }]);
    expect(foods[WINE_ID].kcalPerUnit).toBeUndefined();
    // A real zero-energy food (water) keeps its measured zero.
    const water = foodsFromSyncRows(
      [{ id: WINE_ID, name: "Water", deleted_at: null,
        per_100g: { energy_kcal: 0, protein: 0, carbohydrate: 0, fat_total: 0 } }],
      [{ food_ref_id: REF_ID, status: "eats", role: "carb", updated_at: AT }],
      [{ id: REF_ID, user_food_id: WINE_ID }]);
    expect(water[WINE_ID].kcalPerUnit).toBe(0);
  });

  it("reads calculated-only energy from a catalog-linked row", () => {
    const foods = foodsFromSyncRows(
      [{ id: WINE_ID, name: "Chicken, breast", deleted_at: null, catalog_food_id: 7,
        per_100g: { energy_kcal_calc: 120, protein: 22.5, carbohydrate: 0, fat_total: 2.6 } }],
      [{ food_ref_id: REF_ID, status: "eats", role: "protein", updated_at: AT }],
      [{ id: REF_ID, user_food_id: WINE_ID }]);
    expect(foods[WINE_ID].kcalPerUnit).toBeCloseTo(1.2, 10);
  });

  it("keeps a calc-only row's energy: its nutrition is known, and it logs 80 kcal per 100 g", () => {
    const foods = foodsFromSyncRows(
      [{ id: WINE_ID, name: "Stock", deleted_at: null, per_100g: { energy_kcal_calc: 80 } }],
      [{ food_ref_id: REF_ID, status: "eats", role: "carb", updated_at: AT }],
      [{ id: REF_ID, user_food_id: WINE_ID }]);
    const stock = foods[WINE_ID];
    expect(stock.nutritionUnknown).toBeUndefined();
    expect(stock.kcalPerUnit).toBeCloseTo(0.8, 10);
    expect(accountPer100g(stock)?.per100g).toEqual({ energy_kcal: 80 });
    expect(accountPerUnit(stock)).toEqual({ energy_kcal: 0.8 });
  });
});

describe("account food unmeasured macros (W004 review)", () => {
  const partialRow = (per_100g: Record<string, unknown>) => foodsFromSyncRows(
    [{ id: WINE_ID, name: "Apple juice", deleted_at: null, per_100g }],
    [{ food_ref_id: REF_ID, status: "eats", role: "carb", updated_at: AT }],
    [{ id: REF_ID, user_food_id: WINE_ID }])[WINE_ID];

  it("never logs or re-stores a macro the row did not measure as 0", () => {
    const juice = partialRow({ energy_kcal: 52, carbohydrate: 13.8 });
    expect(juice.unmeasured).toEqual(["protein", "fat"]);
    expect(accountPer100g(juice)?.per100g).toEqual({ energy_kcal: 52, carbohydrate: 13.8 });
    expect(accountPerUnit(juice)).toEqual({ energy_kcal: 0.52, carbohydrate: 0.138 });
    expect(omitUnmeasured(juice, perUnitTo100g(juice.perUnit, 1, juice.kcalPerUnit)))
      .toEqual({ energy_kcal: 52, carbohydrate: 13.8 });
  });

  it("keeps a measured zero and drops the unmeasured mark once the user edits the macros", () => {
    const water = partialRow({ energy_kcal: 0, protein: 0, carbohydrate: 0, fat_total: 0 });
    expect(water.unmeasured).toBeUndefined();
    const juice = partialRow({ energy_kcal: 52, carbohydrate: 13.8 });
    const edited = withPerUnit(juice, { ...juice.perUnit, protein: 0.002 });
    expect(edited.unmeasured).toBeUndefined();
    expect(accountPer100g(edited)?.per100g).toHaveProperty("fat_total", 0);
  });
});

describe("account food energy on the Foods page (W004 review)", () => {
  it("shows the energy the logger stores for a drink, not its 4/4/9 figure", () => {
    const wine = syncedWine();
    expect(kcalPer100Label(wine)).toBe("85 kcal / 100 g");
    expect(servingOfFood(wine).kcalPer100g).toBe(85);
    expect(mineAsDb(wine).per100g.kcal).toBeCloseTo(85, 6);
  });
});
