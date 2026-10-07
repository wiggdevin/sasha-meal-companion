import { describe, expect, it } from "vitest";
import { frozenEatenShare, planningSlotTarget, resolveDay, scaledSlotTarget } from "./resolve";
import { defaultStore } from "./store";
import type { FoodComponent } from "./types";
import { getMealOptions } from "./meals";

const recipeSnapshotComponent: FoodComponent = { name: "Chicken burrito bowl", qty: 1, unit: "whole",
  role: "free", macros: { kcal: 700, protein: 45, carbs: 70, fat: 25 } };

const DATE = "2026-09-07";
const cooked: FoodComponent = { name: "My saved rice", qty: 1, unit: "cup", role: "carb",
  macros: { kcal: 200, protein: 5, carbs: 40, fat: 2 } };

describe("account layout day", () => {
  it("shows only meal slots and keeps authored content with no inherited card", () => {
    const store = defaultStore();
    store.settings.mealsPerDay = 4;
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-2": { baseMealId: null, title: "My rice", components: [cooked] },
    } };
    const day = resolveDay(store, DATE);
    expect(day.slots.map((slot) => slot.slot)).toEqual([
      "meal-1", "meal-2", "meal-3", "meal-4",
    ]);
    expect(day.slots[1].meal?.name).toBe("My rice");
    expect(day.slots.filter((slot) => slot.meal)).toHaveLength(1);
  });

  it("splits remaining targets after a fixed user meal", () => {
    const store = defaultStore();
    store.settings.mealsPerDay = 4;
    store.settings.activeTargetProfile = {
      revision: 1,
      training: { kcal: 2400, protein: 160, carbs: 260, fat: 80 },
      rest: { kcal: 2000, protein: 160, carbs: 160, fat: 80 },
    };
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-2": { baseMealId: null, title: "My rice", components: [cooked] },
    } };
    const day = resolveDay(store, DATE);
    expect(day.slots.map((slot) => slot.slot)).toHaveLength(4);
    // 1800 kcal, 155 P, 120 C, 78 F are left for three meals. Those macros hold 1802 kcal, so
    // carbs give up the 2 kcal and every share stays inside its kcal (lib/plan/slot-share.ts).
    expect(scaledSlotTarget(store, DATE, day.dayType, "meal-1")).toEqual({
      kcal: 600, protein: 155 / 3, carbs: (1800 - 4 * 155 - 9 * 78) / 4 / 3, fat: 26,
    });
    expect(scaledSlotTarget(store, DATE, day.dayType, "meal-2")).toBeUndefined();
  });

  it("includes an added third meal on a two-meal day and excludes a removed meal", () => {
    const store = defaultStore();
    store.settings.mealsPerDay = 2;
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-3": { baseMealId: null, components: [], added: true, time: "21:00" },
      "meal-1": { baseMealId: null, components: [], removed: true },
    } };
    expect(resolveDay(store, DATE).slots.map((slot) => slot.slot)).toEqual(["meal-2", "meal-3"]);
  });

  it("resizes generated meals around a cleared card", () => {
    const store = defaultStore();
    store.settings.mealsPerDay = 3;
    store.settings.activeTargetProfile = { revision: 1,
      training: { kcal: 1800, protein: 120, carbs: 180, fat: 60 },
      rest: { kcal: 1800, protein: 120, carbs: 180, fat: 60 } };
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-2": { baseMealId: null, components: [] },
    } };
    expect(scaledSlotTarget(store, DATE, "rest", "meal-1")?.kcal).toBe(900);
    expect(scaledSlotTarget(store, DATE, "rest", "meal-2")).toBeUndefined();
    expect(planningSlotTarget(store, DATE, "rest", "meal-2")).toEqual({
      kcal: 600, protein: 40, carbs: 60, fat: 20,
    });
    expect(planningSlotTarget(store, DATE, "rest", "meal-1")?.kcal).toBe(900);
  });

  it("reserves a cleared slot's planning share after an authored meal", () => {
    const store = defaultStore();
    store.settings.mealsPerDay = 4;
    store.settings.activeTargetProfile = { revision: 1,
      training: { kcal: 1800, protein: 120, carbs: 180, fat: 60 },
      rest: { kcal: 1800, protein: 120, carbs: 180, fat: 60 } };
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-1": { baseMealId: null, components: [cooked], title: "My rice" },
      "meal-4": { baseMealId: null, components: [], cleared: true },
    } };
    expect(scaledSlotTarget(store, DATE, "rest", "meal-4")).toBeUndefined();
    expect(planningSlotTarget(store, DATE, "rest", "meal-4")).toEqual({
      kcal: 1600 / 3, protein: 115 / 3, carbs: 140 / 3, fat: 58 / 3,
    });
  });

  it("assigns a time to added meals even when an old client omitted the override time", () => {
    const store = defaultStore();
    store.settings.mealsPerDay = 3;
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-4": { baseMealId: null, components: [], added: true },
      "meal-5": { baseMealId: null, components: [], added: true },
    } };
    const day = resolveDay(store, DATE);
    expect(day.slots.find((slot) => slot.slot === "meal-4")?.time).toBe("21:00");
    expect(day.slots.find((slot) => slot.slot === "meal-5")?.time).toBe("21:30");
  });

  it("shows and totals only explicitly recorded historical rituals, never future defaults", () => {
    const store = defaultStore();
    const coffee = getMealOptions("rest", "coffee")[0];
    store.days[DATE] = { date: DATE, eaten: {
      coffee: "2026-09-07T14:00:00Z", "hot-chocolate": "2026-09-07T23:00:00Z",
    }, itemOverrides: {
      "hot-chocolate": { baseMealId: null, title: "My drink", components: [cooked] },
    } };
    const day = resolveDay(store, DATE);
    expect(day.slots.map((slot) => slot.slot)).toContain("coffee");
    expect(day.slots.find((slot) => slot.slot === "hot-chocolate")?.meal?.name).toBe("My drink");
    expect(day.consumed.kcal).toBe(coffee.macros.kcal + cooked.macros.kcal);
    expect(resolveDay(store, "2026-09-08").slots.some((slot) =>
      slot.slot === "coffee" || slot.slot === "hot-chocolate")).toBe(false);
  });

  it("keeps a saved historical ritual choice visible without counting an unlogged meal", () => {
    const store = defaultStore();
    store.days[DATE] = { date: DATE, itemOverrides: {
      "post-refuel": { baseMealId: null, title: "My smoothie", components: [cooked] },
    } };
    const day = resolveDay(store, DATE);
    expect(day.slots.find((slot) => slot.slot === "post-refuel")?.meal?.name).toBe("My smoothie");
    expect(day.consumed.kcal).toBe(0);
  });

  it("keeps an authored meal beyond a later lower meal-count choice", () => {
    const store = defaultStore();
    store.settings.mealsPerDay = 2;
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-4": { baseMealId: null, title: "Saved fourth meal", components: [cooked] },
      "meal-5": { baseMealId: null, components: [], time: "20:00" },
    } };
    const day = resolveDay(store, DATE);
    expect(day.slots.map((slot) => slot.slot)).toEqual(["meal-1", "meal-2", "meal-4"]);
    expect(day.slots.find((slot) => slot.slot === "meal-4")?.meal?.name).toBe("Saved fourth meal");
  });

  describe("a slot eaten as a recipe and then edited", () => {
    function storeForBudget() {
      const store = defaultStore();
      store.settings.mealsPerDay = 3;
      store.settings.activeTargetProfile = { revision: 1,
        training: { kcal: 1800, protein: 120, carbs: 180, fat: 60 },
        rest: { kcal: 1800, protein: 120, carbs: 180, fat: 60 } };
      return store;
    }

    it("sizes the other slots by the edited meal, not the stale recipe snapshot", () => {
      const store = storeForBudget();
      store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-09-07T12:00:00Z" },
        consumedSlots: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [recipeSnapshotComponent] } },
        // `chooseMealAlternative`/`saveMealEdit` set the override's `baseMealId` to whatever was
        // displayed just before the edit — the eaten recipe's own id — so a genuine post-eating
        // edit keeps that same lineage; only its components change.
        itemOverrides: { "meal-2": { baseMealId: "recipe:burrito", title: "Side salad",
          components: [cooked], followPlan: false } } };
      // The remaining budget for meal-1/meal-3 must reserve `cooked` (200 kcal), the current
      // override, not the 700 kcal the stale consumedSlots snapshot still holds.
      expect(scaledSlotTarget(store, DATE, "rest", "meal-1")).toEqual({
        kcal: (1800 - 200) / 2, protein: (120 - 5) / 2, carbs: (180 - 40) / 2, fat: (60 - 2) / 2,
      });
      // And the edited slot itself is "fixed" by its own override, never offered a second,
      // open planning share on top of what it already holds (round-4 audit, DeepSeek BLOCKER).
      expect(scaledSlotTarget(store, DATE, "rest", "meal-2")).toBeUndefined();
      expect(planningSlotTarget(store, DATE, "rest", "meal-2")).toBeUndefined();
    });

    // 2026-10-03 round-4 audit (Codex MAJOR, via the recipe-accept overlay's own "an eaten
    // snapshot is historical fact" rule in lib/recipes/accepted-overlay.ts): a slot can carry an
    // override from BEFORE a recipe was ever accepted there — unrelated lineage, a different
    // baseMealId — that the overlay deliberately never reconciles once the slot is eaten. That
    // stale leftover must not outrank the recipe actually eaten, the way a genuine post-eating
    // edit (same baseMealId, different components, above) correctly does.
    it("still reserves the eaten recipe over an unrelated pre-existing override", () => {
      const store = storeForBudget();
      store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-09-07T12:00:00Z" },
        consumedSlots: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [recipeSnapshotComponent] } },
        itemOverrides: { "meal-2": { baseMealId: null, title: "My rice",
          components: [cooked], followPlan: false } } };
      expect(scaledSlotTarget(store, DATE, "rest", "meal-1")).toEqual({
        kcal: (1800 - 700) / 2, protein: (120 - 45) / 2, carbs: (180 - 70) / 2, fat: (60 - 25) / 2,
      });
    });

    it("still uses the recipe snapshot while the override matches what was eaten", () => {
      const store = storeForBudget();
      store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-09-07T12:00:00Z" },
        consumedSlots: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [recipeSnapshotComponent] } },
        itemOverrides: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [recipeSnapshotComponent] } } };
      expect(scaledSlotTarget(store, DATE, "rest", "meal-1")).toEqual({
        kcal: (1800 - 700) / 2, protein: (120 - 45) / 2, carbs: (180 - 70) / 2, fat: (60 - 25) / 2,
      });
    });

    it("ignores a consumedSlots snapshot left over on a slot that is not eaten", () => {
      const store = storeForBudget();
      store.days[DATE] = { date: DATE,
        consumedSlots: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [recipeSnapshotComponent] } } };
      // No `eaten` mark: meal-2 is still an open, generated slot and must not be treated as
      // fixed at the stale snapshot's size.
      expect(scaledSlotTarget(store, DATE, "rest", "meal-2")).toBeDefined();
      expect(scaledSlotTarget(store, DATE, "rest", "meal-1")).toEqual({
        kcal: 600, protein: 40, carbs: 60, fat: 20,
      });
    });

    // 2026-10-03 round-2 audit (DeepSeek MAJOR #3, Grok MINOR): a diverged override that is
    // itself not a "fixed" replacement (cleared, or still followPlan) must not make the slot's
    // already-eaten macros disappear from the budget — the account really did eat them.
    it("still reserves the eaten recipe's macros when the override only clears the plan", () => {
      const store = storeForBudget();
      store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-09-07T12:00:00Z" },
        consumedSlots: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [recipeSnapshotComponent] } },
        itemOverrides: { "meal-2": { baseMealId: "recipe:burrito", components: [], cleared: true } } };
      expect(scaledSlotTarget(store, DATE, "rest", "meal-1")).toEqual({
        kcal: (1800 - 700) / 2, protein: (120 - 45) / 2, carbs: (180 - 70) / 2, fat: (60 - 25) / 2,
      });
    });

    it("still reserves the eaten recipe's macros when a stale override still says followPlan", () => {
      const store = storeForBudget();
      store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-09-07T12:00:00Z" },
        consumedSlots: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [recipeSnapshotComponent] } },
        itemOverrides: { "meal-2": { baseMealId: null, components: [], followPlan: true, time: "19:00" } } };
      expect(scaledSlotTarget(store, DATE, "rest", "meal-1")).toEqual({
        kcal: (1800 - 700) / 2, protein: (120 - 45) / 2, carbs: (180 - 70) / 2, fat: (60 - 25) / 2,
      });
    });

    // 2026-10-03 round-3 audit (Grok MAJOR): planningSlotTarget's own "pretend this slot is
    // cleared" shortcut must not apply to a slot that was genuinely eaten — otherwise the
    // Plan sheet would offer a fresh share for a slot that already holds real eaten calories,
    // stacking a new portion on top instead of reserving what was actually eaten.
    it("offers no planning share for a slot that was eaten and only cleared afterward", () => {
      const store = storeForBudget();
      store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-09-07T12:00:00Z" },
        consumedSlots: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [recipeSnapshotComponent] } },
        itemOverrides: { "meal-2": { baseMealId: "recipe:burrito", components: [], cleared: true } } };
      expect(planningSlotTarget(store, DATE, "rest", "meal-2")).toBeUndefined();
    });

    // 2026-10-03 round-4 audit (Codex MAJOR): an ordinary eaten mark on a plain, non-recipe meal
    // carries no consumedSlots entry at all (writeEatenSlot only records one for a "suggested:"
    // or "recipe:" meal) — checking `!consumed` alone missed this far more common eaten shape.
    it("offers no planning share for an eaten slot with no recipe snapshot at all", () => {
      const store = storeForBudget();
      store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-09-07T12:00:00Z" },
        itemOverrides: { "meal-2": { baseMealId: null, components: [], cleared: true } } };
      expect(planningSlotTarget(store, DATE, "rest", "meal-2")).toBeUndefined();
    });

    // An eaten slot with neither a recipe snapshot nor a priceable override (absent, or a
    // followPlan shell) is frozen at the even share, so every other slot keeps its 600. Round 5 of
    // the #318 audit made it reserve zero instead, which emptied the eaten card and grew the other
    // meals to 900 each (tests/plan/eaten-generated-meal.test.ts reproduces it end to end). It is
    // fixed, not open, so it has no open share of its own (2026-10-04 audit).
    const followPlanShell: FoodComponent[] = [];
    it.each<[string, { baseMealId: null; components: FoodComponent[]; followPlan: true; time: string } | undefined]>([
      ["no override at all", undefined],
      ["a followPlan shell", { baseMealId: null, components: followPlanShell, followPlan: true, time: "19:00" }],
    ])("keeps the even share for an eaten generated meal with %s", (_label, override) => {
      const store = storeForBudget();
      store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-09-07T12:00:00Z" },
        itemOverrides: override ? { "meal-2": override } : undefined };
      const share = { kcal: 600, protein: 40, carbs: 60, fat: 20 };
      expect(frozenEatenShare(store, DATE, "rest", "meal-2")).toEqual(share);
      expect(scaledSlotTarget(store, DATE, "rest", "meal-2")).toBeUndefined();
      expect(scaledSlotTarget(store, DATE, "rest", "meal-1")).toEqual(share);
    });

    it("still matches a snapshot through a harmless floating-point round-trip", () => {
      const store = storeForBudget();
      const roundTripped = { ...recipeSnapshotComponent,
        macros: { ...recipeSnapshotComponent.macros, kcal: 700 + 1e-9 } };
      store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-09-07T12:00:00Z" },
        consumedSlots: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [recipeSnapshotComponent] } },
        itemOverrides: { "meal-2": { baseMealId: "recipe:burrito", title: "Chicken burrito bowl",
          components: [roundTripped] } } };
      // Still "the same meal" (tiny float noise, not a real edit) — reserve the snapshot's own
      // macros, not double-count or treat this as a diverged edit.
      expect(scaledSlotTarget(store, DATE, "rest", "meal-1")).toEqual({
        kcal: (1800 - 700) / 2, protein: (120 - 45) / 2, carbs: (180 - 70) / 2, fat: (60 - 25) / 2,
      });
    });
  });
});
