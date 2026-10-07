import { describe, expect, it } from "vitest";
import { nextMealSlot, addedMealTime, clearMeal, removeMeal, restoreAddedMeal } from "@/lib/today/meal-actions";
import { resolveDay } from "@/lib/resolve";
import { defaultSettings } from "@/lib/store";
import type { FoodComponent, SlotOverride, Store } from "@/lib/types";

const DATE = "2026-09-27";
const rice: FoodComponent = { name: "Rice", qty: 100, unit: "g", role: "carb",
  macros: { kcal: 130, protein: 2, carbs: 28, fat: 0 } };
const base = (): Store => ({ version: 1, firstOpenedAt: DATE,
  settings: { ...defaultSettings(), mealsPerDay: 3 }, days: {}, foods: {} });

describe("per-date meal actions", () => {
  it("clears a meal to an empty card while retaining its authored time and restores an exact prior override", () => {
    const before: SlotOverride = { baseMealId: "mine", components: [rice], title: "My rice",
      time: "13:15" };
    const cleared = clearMeal(before, "mine");
    expect(cleared).toEqual({ baseMealId: "mine", components: [], time: "13:15", cleared: true });
    const store = base();
    store.days[DATE] = { date: DATE, itemOverrides: { "meal-2": cleared } };
    expect(resolveDay(store, DATE).slots.find((slot) => slot.slot === "meal-2"))
      .toMatchObject({ meal: null, components: [], time: "13:15" });
    expect(before).toMatchObject({ title: "My rice", components: [rice] });
  });

  it("hides only this date with a reversible marker and retains prior authored content", () => {
    const before: SlotOverride = { baseMealId: "mine", components: [rice], title: "My rice" };
    const removed = removeMeal(before, "mine");
    expect(removed).toMatchObject({ ...before, removed: true });
    const store = base();
    store.days[DATE] = { date: DATE, itemOverrides: { "meal-1": removed } };
    expect(resolveDay(store, DATE).slots.some((slot) => slot.slot === "meal-1")).toBe(false);
    expect(resolveDay(store, "2026-09-28").slots.some((slot) => slot.slot === "meal-1")).toBe(true);
  });

  it("keeps an already eaten snapshot visible and counted despite a stale removal marker", () => {
    const before: SlotOverride = { baseMealId: "mine", components: [rice], title: "My rice" };
    const store = base();
    store.days[DATE] = { date: DATE,
      eaten: { "meal-1": "2026-09-27T12:00:00Z", "meal-4": "2026-09-27T15:00:00Z",
        coffee: "2026-09-27T08:00:00Z" },
      itemOverrides: {
        "meal-1": removeMeal(before, "mine"),
        "meal-4": removeMeal({ ...before, added: true, time: "15:00" }, "mine"),
        coffee: removeMeal(before, "mine"),
      },
    };

    const resolved = resolveDay(store, DATE);
    for (const id of ["meal-1", "meal-4", "coffee"]) {
      expect(resolved.slots.find((slot) => slot.slot === id))
        .toMatchObject({ eaten: true, macros: rice.macros });
    }
    expect(resolved.consumed.kcal).toBe(390);
    expect(store.days[DATE].itemOverrides?.["meal-1"]?.components).toEqual([rice]);
  });

  it("adds the next unused extra meal, reopens a removed extra and caps its time", () => {
    const store = base();
    expect(nextMealSlot(store, DATE, "rest")).toBe("meal-4");
    expect(addedMealTime(resolveDay(store, DATE).slots)).toBe("21:00");
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-4": { baseMealId: null, components: [], added: true, time: "21:00" },
      "meal-5": { baseMealId: "mine", components: [rice], title: "Mine", added: true,
        removed: true, time: "21:20" },
    } };
    expect(nextMealSlot(store, DATE, "rest")).toBe("meal-5");
    expect(addedMealTime(resolveDay(store, DATE).slots)).toBe("21:30");
    expect(restoreAddedMeal(store.days[DATE].itemOverrides?.["meal-5"], "21:30"))
      .toMatchObject({ title: "Mine", components: [rice], added: true, time: "21:20" });
    store.days[DATE].itemOverrides!["meal-5"] = restoreAddedMeal(
      store.days[DATE].itemOverrides?.["meal-5"], "21:30");
    store.days[DATE].itemOverrides!["meal-6"] = { baseMealId: null, components: [], added: true };
    expect(nextMealSlot(store, DATE, "rest")).toBeNull();
  });

  it("keeps a newly added meal eligible for generation but never regenerates a cleared one", () => {
    const store = base();
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-4": restoreAddedMeal(undefined, "21:00"),
    } };
    expect(store.days[DATE].itemOverrides?.["meal-4"])
      .toEqual({ baseMealId: null, components: [], added: true, followPlan: true, time: "21:00" });
    const cleared = clearMeal(store.days[DATE].itemOverrides?.["meal-4"], null);
    expect(cleared).toMatchObject({ added: true, cleared: true, components: [] });
    store.days[DATE].itemOverrides!["meal-4"] = cleared;
    expect(resolveDay(store, DATE).slots.find((slot) => slot.slot === "meal-4")?.meal).toBeNull();
  });
});
