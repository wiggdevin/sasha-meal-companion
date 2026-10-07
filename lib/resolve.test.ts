import { describe, expect, it } from "vitest";
import type { Food } from "./foods";
import { dayNutrientTotals, entryMacros, resolveDay, snapshotMacros } from "./resolve";
import { defaultSettings } from "./store";
import type { FoodComponent, LoggedFood, Store } from "./types";

const DATE = "2026-09-07";
const targets = {
  revision: 3,
  training: { kcal: 2100, protein: 130, carbs: 220, fat: 78 },
  rest: { kcal: 1800, protein: 130, carbs: 150, fat: 76 },
  pins: { trainingKcal: null, restKcal: null, proteinG: null },
};

function food(id: string, role: Food["role"], perUnit: Food["perUnit"]): Food {
  return { id, name: id, role, unit: "g", perUnit, status: "eats",
    updatedAt: "2026-09-20T12:00:00Z" };
}

function store(options: { withTargets?: boolean; withFoods?: boolean } = {}): Store {
  return {
    version: 1,
    firstOpenedAt: "2026-09-20T12:00:00Z",
    settings: {
      ...defaultSettings(),
      trainingWeekdays: [1],
      activeTargetProfile: options.withTargets ? targets : null,
    },
    days: {},
    foods: options.withFoods ? {
      protein: food("protein", "protein", { protein: 0.25, carbs: 0, fat: 0.04 }),
      carb: food("carb", "carb", { protein: 0.02, carbs: 0.28, fat: 0 }),
      fat: food("fat", "fat", { protein: 0, carbs: 0, fat: 0.2 }),
    } : {},
  };
}

describe("resolveDay authority and empty slots", () => {
  it("returns every scheduled slot empty and no targets for a fresh account", () => {
    const day = resolveDay(store(), DATE);
    expect(day.targets).toBeNull();
    expect(day.slots).toHaveLength(3);
    expect(day.slots.every((slot) => slot.meal === null)).toBe(true);
    expect(day.slots.every((slot) => slot.components.length === 0)).toBe(true);
    expect(day.slots.every((slot) => slot.macros.kcal === 0 && !slot.eaten)).toBe(true);
  });

  it("does not rotate foods when the target revision is missing", () => {
    expect(resolveDay(store({ withFoods: true }), DATE).slots.every((slot) => slot.meal === null))
      .toBe(true);
  });

  it("keeps every slot empty when targets exist but the account has no foods", () => {
    const day = resolveDay(store({ withTargets: true }), DATE);
    expect(day.targets).toEqual(targets.training);
    expect(day.slots.every((slot) => slot.meal === null)).toBe(true);
  });

  it("materializes an explicit plan override without account foods or targets", () => {
    const value = store();
    const component: FoodComponent = { name: "Catalog rice", qty: 150, unit: "g", role: "carb",
      macros: { kcal: 190, protein: 4, carbs: 42, fat: 0 } };
    value.days[DATE] = { date: DATE, itemOverrides: { "meal-1": {
      baseMealId: null, title: "Rice bowl", components: [component],
    } } };
    const slot = resolveDay(value, DATE).slots.find((item) => item.slot === "meal-1");
    expect(slot).toMatchObject({ meal: { name: "Rice bowl" }, components: [component],
      macros: component.macros });
  });

  it("adds logged extras to consumed totals even without targets", () => {
    const value = store();
    value.days[DATE] = { date: DATE, extras: [{
      id: "e1", foodId: "banana", name: "Banana", portionLabel: "1", qty: 1, grams: 118,
      macros: { kcal: 105, protein: 1, carbs: 27, fat: 0 }, at: "2026-09-20T12:00:00Z",
    }] };
    expect(resolveDay(value, DATE).consumed).toEqual({ kcal: 105, protein: 1, carbs: 27, fat: 0 });
  });
});

function nutrient(amount: number | null, unit: string) {
  return { amount, unit, basis: "per_100g" as const, source: "fdc_sr_legacy",
    source_version: "2026-04", revision_id: 910 };
}

const snapshotEntry = {
  id: "e1", foodId: "catalog:41", name: "Food", portionLabel: "140 g", qty: 140,
  grams: 140, macros: { kcal: 9999, protein: 9999, carbs: 9999, fat: 9999 },
  at: "2026-09-11T18:00:00.000Z",
  items: [{
    id: "i1", seq: 1, food_ref_id: "uuid-1", grams: 140, qty: 140, unit: "g",
    name: "Food", portionLabel: "140 g", macros: { kcal: 9999, protein: 9999, carbs: 9999, fat: 9999 },
    snapshot: { energy_kcal: nutrient(231, "kcal"), protein: nutrient(43.4, "g"),
      carbohydrate: nutrient(0, "g"), fat_total: nutrient(5, "g"), iron: nutrient(1.5, "mg") },
  }],
} as unknown as LoggedFood;

describe("logged nutrient resolution", () => {
  it("prefers frozen item snapshots", () => {
    expect(snapshotMacros(snapshotEntry.items)).toEqual({ kcal: 231, protein: 43.4, carbs: 0, fat: 5 });
    expect(entryMacros(snapshotEntry).kcal).toBe(231);
  });

  it("totals non-macro nutrients", () => {
    const value = store();
    value.days[DATE] = { date: DATE, extras: [snapshotEntry] };
    expect(dayNutrientTotals(resolveDay(value, DATE)).get("iron")?.amount).toBe(1.5);
  });

  it("counts every logged item for coverage, as the server's daily_totals does (#22)", () => {
    const value = store();
    const empty = { ...snapshotEntry, id: "e2", items: [{ ...snapshotEntry.items![0], id: "i2",
      snapshot: {} }] } as unknown as LoggedFood;
    value.days[DATE] = { date: DATE, extras: [snapshotEntry, empty] };
    const totals = dayNutrientTotals(resolveDay(value, DATE));
    // Server: items_with_value 1, items_total 2 -> coverage 0.5 (it was 1.0 on the phone).
    expect(totals.get("energy_kcal")).toMatchObject({ amount: 231, itemsWithValue: 1, itemsTotal: 2, coverage: 0.5 });
    expect(totals.get("iron")?.coverage).toBe(0.5);
  });
});
