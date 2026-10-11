/**
 * W004 (audit 2026-10-10, A154): adding a catalog food to Eats/Favored copies only the codes the
 * catalog revision measured into `user_foods.per_100g`. An unmeasured nutrient stays absent (never a
 * stored 0, which every reader treats as a measured zero), and a revision whose energy is only the
 * Atwater-calculated `energy_kcal_calc` keeps it under its own code, so the energy rule
 * (lib/nutrients/energy.ts) still finds it in the coach, the snapshot and the day totals.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upserts: Record<string, unknown>[] = [];
let detailPer100g: Record<string, { amount: number | null; unit: string }> = {};

vi.mock("@/lib/catalog-client", () => ({
  getFoodDetail: async () => ({ kind: "ok", detail: { description: "Chicken, breast, raw",
    per100g: detailPer100g } }),
}));
vi.mock("@/lib/foods/prefs-client", () => ({ setFoodMembership: async () => null }));
vi.mock("@/lib/supabase/client", () => {
  const single = (data: unknown) => ({ single: async () => ({ data, error: null }) });
  const eqChain = (data: unknown): Record<string, unknown> => ({
    eq: () => eqChain(data), ...single(data) });
  return { browserClient: () => ({
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>) => {
        upserts.push(row);
        return { select: () => single({ rev: 1 }) };
      },
      select: () => eqChain(table === "food_refs" ? { id: "ref-1" }
        : { rev: 1, status: "eats", note: null, no_cook: false }),
    }),
    rpc: async () => ({ data: { status: "applied", rev: 2 }, error: null }),
  }) };
});

import { addCatalogFood } from "@/components/add-food/catalog-food";
import { accountFoodKcalPer100g, accountFoodPer100g } from "@/lib/catalog/account-food-nutrients";
import { resetTestAccount } from "@/tests/helpers/account";

const g = (amount: number | null) => ({ amount, unit: "g" });
const kcal = (amount: number | null) => ({ amount, unit: "kcal" });

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  upserts.length = 0;
  await resetTestAccount();
});

describe("accountFoodPer100g", () => {
  it("keeps calculated-only energy under its own code and leaves the reported code absent", () => {
    expect(accountFoodPer100g({ energy_kcal_calc: kcal(120), protein: g(22.5),
      carbohydrate: g(0), fat_total: g(2.6) }))
      .toEqual({ energy_kcal_calc: 120, protein: 22.5, carbohydrate: 0, fat_total: 2.6 });
  });

  it("leaves every absent, null, negative or non-number nutrient absent — never 0", () => {
    const stored = accountFoodPer100g({ energy_kcal: kcal(null), protein: g(-1),
      carbohydrate: { amount: Number.NaN } });
    expect(stored).toEqual({});
  });

  it("keeps a measured zero as 0", () => {
    expect(accountFoodPer100g({ energy_kcal: kcal(0), protein: g(0), carbohydrate: g(0),
      fat_total: g(0) })).toEqual({ energy_kcal: 0, protein: 0, carbohydrate: 0, fat_total: 0 });
  });

  it("selects energy by the one rule: reported, else calculated, else unknown", () => {
    expect(accountFoodKcalPer100g({ energy_kcal: 165, energy_kcal_calc: 150 })).toBe(165);
    expect(accountFoodKcalPer100g({ energy_kcal_calc: 120 })).toBe(120);
    expect(accountFoodKcalPer100g({ protein: 3 })).toBeNull();
  });
});

describe("addCatalogFood", () => {
  it("stores a calc-only Foundation food with its calculated energy, not energy_kcal: 0", async () => {
    detailPer100g = { energy_kcal_calc: kcal(120), protein: g(22.5), carbohydrate: g(0),
      fat_total: g(2.6) };
    const food = await addCatalogFood(42, 900);
    const row = upserts.find((r) => r.kind === "custom") as { per_100g: Record<string, number> };
    expect(row.per_100g).toEqual({ energy_kcal_calc: 120, protein: 22.5, carbohydrate: 0,
      fat_total: 2.6 });
    expect(row.per_100g).not.toHaveProperty("energy_kcal");
    // The phone's food carries the same energy per gram.
    expect(food.kcalPerUnit).toBeCloseTo(1.2, 10);
  });

  it("stores no code the revision did not measure", async () => {
    detailPer100g = { energy_kcal: kcal(52), carbohydrate: g(13.8), protein: g(null) };
    const food = await addCatalogFood(43, 901);
    const row = upserts.find((r) => r.kind === "custom") as { per_100g: Record<string, number> };
    expect(row.per_100g).toEqual({ energy_kcal: 52, carbohydrate: 13.8 });
    expect(food.kcalPerUnit).toBeCloseTo(0.52, 10);
    // The phone's food reads the unmeasured macros as 0 but never writes them back.
    expect(food.unmeasured).toEqual(["protein", "fat"]);
  });

  it("marks a revision with no nutrition at all as unknown", async () => {
    detailPer100g = {};
    const food = await addCatalogFood(44, 902);
    const row = upserts.find((r) => r.kind === "custom") as { per_100g: Record<string, number> };
    expect(row.per_100g).toEqual({});
    expect(food.nutritionUnknown).toBe(true);
    expect(food.kcalPerUnit).toBeUndefined();
  });
});
