import { describe, expect, it } from "vitest";
import { defaultStore } from "@/lib/store";
import { resolveDay } from "@/lib/resolve";
import type { Store } from "@/lib/types";
import { starterChoices, starterDefaultIds, starterFood } from "./starter";
import { layoutMealsForDay, usableForGeneration } from "./layout-plan";
import type { Food } from "@/lib/foods";

const rules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };
const start = new Date("2026-10-01T12:00:00Z");
function date(offset: number): string { const d = new Date(start); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); }
function account(flags: string[], kcal: number): Store {
  const store = defaultStore();
  const choices = starterChoices(flags, rules);
  store.foods = Object.fromEntries(starterDefaultIds(choices).map((id) => {
    const food = starterFood(id, "eats"); return [food.id, food];
  }));
  store.settings = { ...store.settings, onboardedAt: "2026-09-26T12:00:00Z", trainingWeekdays: [],
    ruleReviewReady: true,
    activeTargetProfile: { revision: 1,
      training: { kcal, protein: 140, carbs: Math.round((kcal - 140 * 4 - 72 * 9) / 4), fat: 72 },
      rest: { kcal, protein: 140, carbs: Math.round((kcal - 140 * 4 - 72 * 9) / 4), fat: 72 },
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } };
  return store;
}

describe("account meal layout generation", () => {
  it("names only foods with positive portions when a protein covers the carb target", () => {
    const food = (id: string, role: Food["role"], unit: Food["unit"],
      perUnit: Food["perUnit"]): Food => ({
      id, name: id, role, unit, perUnit, status: "eats", updatedAt: "2026-09-27",
    });
    const foods = {
      lentils: food("Lentils", "protein", "cup", { protein: 18, carbs: 40, fat: 1 }),
      quinoa: food("Quinoa", "carb", "cup", { protein: 8, carbs: 39, fat: 4 }),
      oil: food("Avocado oil", "fat", "tbsp", { protein: 0, carbs: 0, fat: 14 }),
    };
    const [result] = layoutMealsForDay("2026-09-29", [{ id: "meal-1",
      target: { kcal: 360, protein: 20, carbs: 12, fat: 12 } }], foods);
    // A legume carries its own starch: quinoa may join it, but every named food is on the plate.
    expect(result.meal.components.every((part) => part.qty > 0)).toBe(true);
    expect(result.meal.name.startsWith("Lentils")).toBe(true);
    for (const word of result.meal.name.replace(/^Lentils/, "").split(/ with | and /).filter(Boolean)) {
      expect(result.meal.components.some((part) => part.name.toLowerCase().startsWith(word.toLowerCase())))
        .toBe(true);
    }
  });

  for (const flags of [[], ["pescatarian"], ["vegetarian"], ["vegan"]]) {
    for (const kcal of [1800, 2100, 2800]) {
      it(`${flags[0] ?? "omnivore"} ${kcal} kcal over 14 dates`, () => {
        const store = account(flags, kcal);
        const count = kcal <= 1800 ? 3 : kcal <= 2600 ? 4 : 5;
        for (let n = 0; n < 14; n++) {
          const day = resolveDay(store, date(n), 0, new Set(Object.keys(store.foods)));
          expect(day.slots).toHaveLength(count);
          expect(day.slots.every((slot) => slot.meal !== null)).toBe(true);
          const proteinNames = day.slots.map((slot) => slot.components.find((component) => component.role === "protein")?.name);
          // D5: a protein may repeat, never in neighbouring slots.
          expect(proteinNames.every((name, i) => name !== undefined && name !== proteinNames[i + 1])).toBe(true);
          const total = day.slots.reduce((sum, slot) => ({ kcal: sum.kcal + slot.macros.kcal, protein: sum.protein + slot.macros.protein }), { kcal: 0, protein: 0 });
          expect(Math.abs(total.kcal - kcal) / kcal).toBeLessThanOrEqual(0.05);
          expect(total.protein).toBeGreaterThanOrEqual(140 * 0.95);
          for (const slot of day.slots) expect(slot.components.every((component) => ["oz", "cup", "tbsp", "whole"].includes(component.unit) && component.qty > 0)).toBe(true);
        }
      });
    }
  }

  it("does not generate from avoided foods or another account's defaults", () => {
    const store = account(["vegan"], 2100);
    for (const food of Object.values(store.foods)) if (food.role === "protein") food.status = "avoid";
    expect(resolveDay(store, date(0), 0, new Set(Object.keys(store.foods)))
      .slots.every((slot) => slot.meal === null)).toBe(true);
  });

  it("waits for the server-backed rule review before suggesting meals", () => {
    const store = account([], 2100);
    store.settings.ruleReviewReady = false;
    expect(resolveDay(store, date(0), 0, new Set(Object.keys(store.foods)))
      .slots.every((slot) => slot.meal === null)).toBe(true);
  });

  it("drops a previously selected Eat when current server eligibility revokes it", () => {
    const store = account([], 2100);
    const all = new Set(Object.keys(store.foods));
    expect(resolveDay(store, date(0), 0, all).slots.every((slot) => slot.meal)).toBe(true);
    const unsafe = Object.entries(store.foods).find(([, food]) => food.role === "protein")![0];
    all.delete(unsafe);
    const day = resolveDay(store, date(0), 0, all);
    expect(day.slots.flatMap((slot) => slot.components).some((part) =>
      part.name === store.foods[unsafe].name)).toBe(false);
    expect(store.foods[unsafe].status).toBe("eats"); // no silent preference mutation
    expect(resolveDay(store, date(0)).slots.every((slot) => slot.meal === null)).toBe(true);
  });

  it("sizes the other meals around an eaten recipe snapshot", () => {
    const store = account([], 2100);
    const dayDate = date(3);
    const eligible = new Set(Object.keys(store.foods));
    const before = resolveDay(store, dayDate, 0, eligible);
    const [first, ...rest] = before.slots;
    const recipe = { name: "Big recipe bowl", qty: 1, unit: "whole" as const, role: "free" as const,
      macros: { kcal: 1200, protein: 60, carbs: 120, fat: 50 } };
    store.days[dayDate] = { date: dayDate, eaten: { [first.slot]: "2026-10-04T12:00:00Z" },
      consumedSlots: { [first.slot]: { baseMealId: "recipe:bowl", title: recipe.name, components: [recipe] } } };
    const after = resolveDay(store, dayDate, 0, eligible);
    expect(after.slots[0].macros.kcal).toBe(1200);
    const others = after.slots.slice(1);
    expect(others).toHaveLength(rest.length);
    // The remaining generated meals share what is left of the day, not an even split of all of it.
    const total = after.slots.reduce((sum, slot) => sum + slot.macros.kcal, 0);
    expect(Math.abs(total - 2100) / 2100).toBeLessThan(0.08);
    expect(others[0].macros.kcal).toBeLessThan(rest[0].macros.kcal);
  });

  it("keeps an eaten generated meal fixed while count and target change", () => {
    const store = account([], 2100);
    const dayDate = date(2);
    const eligible = new Set(Object.keys(store.foods));
    const first = resolveDay(store, dayDate, 0, eligible).slots[0];
    store.days[dayDate] = { date: dayDate,
      eaten: { [first.slot]: "2026-10-03T12:00:00Z" },
      itemOverrides: { [first.slot]: { baseMealId: first.meal!.id,
        title: first.meal!.name, components: first.components } } };
    store.settings.mealsPerDay = 3;
    store.settings.activeTargetProfile!.rest.kcal = 2250;
    store.settings.activeTargetProfile!.training.kcal = 2250;
    const changed = resolveDay(store, dayDate, 0, eligible);
    expect(changed.slots).toHaveLength(3);
    expect(changed.slots.find((slot) => slot.slot === first.slot)?.macros).toEqual(first.macros);
    expect(changed.consumed.kcal).toBe(Math.round(first.macros.kcal));
    const names = changed.slots.map((slot) => slot.components.find((part) =>
      part.role === "protein")?.name);
    expect(new Set(names).size).toBe(3);
    const total = changed.slots.reduce((sum, slot) => sum + slot.macros.kcal, 0);
    expect(Math.abs(total - 2250) / 2250).toBeLessThanOrEqual(0.05);
  });

  it("fills a dated added meal, then keeps an explicitly cleared card empty", () => {
    const store = account([], 2100);
    const dayDate = date(3);
    const eligible = new Set(Object.keys(store.foods));
    store.days[dayDate] = { date: dayDate, itemOverrides: { "meal-5": {
      baseMealId: null, components: [], added: true, followPlan: true, time: "20:15",
    } } };
    const added = resolveDay(store, dayDate, 0, eligible);
    expect(added.slots).toHaveLength(5);
    expect(added.slots.find((slot) => slot.slot === "meal-5"))
      .toMatchObject({ time: "20:15", meal: expect.objectContaining({ id: expect.stringContaining("suggested:") }) });
    store.days[dayDate].itemOverrides!["meal-5"] = {
      baseMealId: null, components: [], added: true, cleared: true, time: "20:15",
    };
    const cleared = resolveDay(store, dayDate, 0, eligible);
    expect(cleared.slots.find((slot) => slot.slot === "meal-5")?.meal).toBeNull();
    expect(cleared.slots.filter((slot) => slot.meal)).toHaveLength(4);
  });
});

describe("nutrition guards (AI-integration audit B4)", () => {
  const food = (id: string, role: Food["role"], perUnit: Food["perUnit"]): Food => ({
    id, name: id, role, unit: "g", perUnit, status: "eats", updatedAt: "2026-10-04",
  });
  const slot = [{ id: "meal-1" as const, target: { kcal: 500, protein: 35, carbs: 50, fat: 15 } }];

  it("accepts only finite, non-negative nutrition with the role's own macro", () => {
    expect(usableForGeneration(food("Eggs", "protein", { protein: 0.13, carbs: 0.01, fat: 0.1 })))
      .toBe(true);
    expect(usableForGeneration(food("Mystery", "protein", { protein: 0, carbs: 0, fat: 0 }))).toBe(false);
    expect(usableForGeneration(food("Bad", "carb", { protein: 0, carbs: Number.NaN, fat: 0 }))).toBe(false);
    expect(usableForGeneration(food("Zero fat", "fat", { protein: 0, carbs: 0.1, fat: 0 }))).toBe(false);
    expect(usableForGeneration(food("Neg", "carb", { protein: -1, carbs: 0.2, fat: 0 }))).toBe(false);
  });

  it("never picks an unusable food, and builds nothing rather than a broken plate", () => {
    const foods = {
      eggs: food("Eggs", "protein", { protein: 0.13, carbs: 0.01, fat: 0.1 }),
      zeroFat: food("Zero fat", "fat", { protein: 0, carbs: 0.1, fat: 0 }),
    };
    // No usable carb for the template's starch: nothing, never a plate with the zero-fat "fat".
    expect(layoutMealsForDay("2026-10-04", slot, foods)).toEqual([]);
    const withOats = { ...foods, oats: food("Oats", "carb", { protein: 0.13, carbs: 0.67, fat: 0.07 }) };
    const [oatPlate] = layoutMealsForDay("2026-10-04", slot, withOats);
    expect(oatPlate.meal.components.map((part) => part.name)).not.toContain("Zero fat");
    const withFat = { ...withOats, butter: food("Butter", "fat", { protein: 0.01, carbs: 0, fat: 0.81 }) };
    const [plate] = layoutMealsForDay("2026-10-04", slot, withFat);
    expect(plate.meal.components.map((part) => part.name)).not.toContain("Zero fat");
    expect(plate.meal.components.every((part) => Number.isFinite(part.macros.kcal))).toBe(true);
  });
});
