// Phase 17 O1 through resolveDay: the slot clock reaches the generator, authored content stays
// frozen (acceptance i), and the shortage reason comes from the generator's own run.
import { describe, expect, it } from "vitest";
import { defaultStore } from "@/lib/store";
import { generatedProteinAvailabilityForDay, generatedShortagesForDay, resolveDay } from "@/lib/resolve";
import type { Food } from "@/lib/foods";
import type { FoodComponent, Store } from "@/lib/types";
import { F } from "@/tests/helpers/meal-foods";

const DATE = "2026-10-04";
const macros = { kcal: 1800, protein: 120, carbs: 190, fat: 60 };

function account(foods: Food[]): { store: Store; eligible: Set<string> } {
  const store = defaultStore();
  store.foods = Object.fromEntries(foods.map((food) => [food.id, { ...food }]));
  store.settings = { ...store.settings, onboardedAt: "2026-09-26T12:00:00Z", trainingWeekdays: [],
    ruleReviewReady: true, mealsPerDay: 3, activeTargetProfile: { revision: 1, training: macros, rest: macros,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  return { store, eligible: new Set(foods.map((food) => food.id)) };
}

const SPEC_A = [F.eggs, F.yogurt, F.oats, F.toast, F.tuna, F.banana, F.rice, F.broccoli, F.oliveOil];
const anchorName = (components: FoodComponent[]) => components.find((part) => part.role === "protein")?.name;

describe("resolveDay with slot occasions", () => {
  it("reads each slot's clock: the 08:00 card is not tuna, and no card is tuna with banana", () => {
    const { store, eligible } = account(SPEC_A);
    const day = resolveDay(store, DATE, 0, eligible);
    expect(day.slots.map((slot) => slot.time)).toEqual(["08:00", "12:30", "18:30"]);
    expect(anchorName(day.slots[0].components)).not.toBe(F.tuna.name);
    for (const slot of day.slots) {
      const names = slot.components.map((part) => part.name);
      expect(names.includes(F.tuna.name) && names.includes(F.banana.name)).toBe(false);
    }
    // Moving that slot to the evening makes it a dinner, with a vegetable on the plate.
    store.days[DATE] = { date: DATE, itemOverrides: { "meal-1": { baseMealId: null, components: [],
      followPlan: true, time: "19:30" } } };
    const moved = resolveDay(store, DATE, 0, eligible).slots.find((slot) => slot.slot === "meal-1")!;
    expect(moved.components.map((part) => part.name)).toContain(F.broccoli.name);
  });

  it("leaves an authored meal and its title exactly as the account set them (acceptance i)", () => {
    const { store, eligible } = account(SPEC_A);
    const porridge: FoodComponent = { name: "My porridge", qty: 1, unit: "whole", role: "free",
      macros: { kcal: 410, protein: 22, carbs: 60, fat: 9 } };
    store.days[DATE] = { date: DATE, itemOverrides: { "meal-1": { baseMealId: "suggested:x",
      title: "Grandma's porridge", components: [porridge], followPlan: false } } };
    const slot = resolveDay(store, DATE, 0, eligible).slots.find((row) => row.slot === "meal-1")!;
    expect(slot.meal?.name).toBe("Grandma's porridge");
    expect(slot.components).toEqual([porridge]);
  });

  it("names the missing part when no coherent plate fits, from the generator's own run", () => {
    const { store, eligible } = account([F.eggs, F.tuna, F.oliveOil]);
    const day = resolveDay(store, DATE, 0, eligible);
    expect(day.slots.every((slot) => slot.meal === null)).toBe(true);
    expect(generatedShortagesForDay(store, DATE, eligible)).toEqual({
      "meal-1": { missing: ["starch", "fruit"], reason: "No breakfast starch or fruit fits yet — try another food" },
      "meal-2": { missing: ["starch"], reason: "No lunch starch fits yet — try another food" },
      "meal-3": { missing: ["starch"], reason: "No dinner starch fits yet — try another food" },
    });
    // Two proteins serve three slots (A B A), so the protein notice stays quiet.
    expect(generatedProteinAvailabilityForDay(store, DATE, eligible)).toEqual({ available: 2, required: 2 });
  });
});
