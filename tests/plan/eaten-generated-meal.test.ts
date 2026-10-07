// Regression (#318, round-5 audit change): ticking an ordinary generated meal as eaten reserved
// ZERO for it in slotTarget, which made the slot "fixed" — so the eaten meal was no longer
// generated (the card went empty) and the other meals grew to fill the whole day
// (504/532/513/519 → EMPTY/701/678/679). An eaten mark with nothing saved is frozen at the even
// share (2026-10-04 audit): its card is an estimate at that share and the other meals keep theirs.
import { describe, expect, it } from "vitest";
import { defaultStore } from "@/lib/store";
import {
  frozenEatenShare, generatedProteinAvailabilityForDay, planningSlotTarget, resolveDay, scaledSlotTarget,
} from "@/lib/resolve";
import { eatenEstimateMeal } from "@/lib/plan/eaten-estimate";
import { starterChoices, starterDefaultIds, starterFood } from "@/lib/foods/starter";
import type { Store } from "@/lib/types";

const DATE = "2026-10-03";
const KCAL = 2100;

function account(): { store: Store; eligible: Set<string> } {
  const rules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
    conditions: [], notes: null };
  const store = defaultStore();
  store.foods = Object.fromEntries(starterDefaultIds(starterChoices([], rules)).map((id) => {
    const food = starterFood(id, "eats"); return [food.id, food];
  }));
  const macros = { kcal: KCAL, protein: 140, carbs: Math.round((KCAL - 140 * 4 - 72 * 9) / 4), fat: 72 };
  store.settings = { ...store.settings, onboardedAt: "2026-09-26T12:00:00Z", trainingWeekdays: [],
    ruleReviewReady: true, activeTargetProfile: { revision: 1, training: macros, rest: macros,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  return { store, eligible: new Set(Object.keys(store.foods)) };
}

describe("an eaten generated meal", () => {
  it("keeps a card at its share and does not inflate the rest of the day", () => {
    const { store, eligible } = account();
    const before = resolveDay(store, DATE, 0, eligible);
    const targets = (s: Store) => ["meal-2", "meal-3", "meal-4"]
      .map((slot) => scaledSlotTarget(s, DATE, "rest", slot as "meal-2")?.kcal);
    const open = targets(store);
    store.days[DATE] = { date: DATE, eaten: { "meal-1": "2026-10-03T08:00:00Z" } };
    const after = resolveDay(store, DATE, 0, eligible);
    const breakfast = after.slots.find((slot) => slot.slot === "meal-1")!;
    expect(breakfast.meal?.name).toMatch(/estimate/i);
    expect(breakfast.eatenAt).toBe("2026-10-03T08:00:00Z");
    expect(breakfast.macros.kcal).toBeCloseTo(KCAL / before.slots.length, 5);
    expect(targets(store)).toEqual(open);
    expect(after.slots.filter((slot) => slot.slot !== "meal-1").every((slot) => slot.meal !== null
      && slot.components.length > 0)).toBe(true);
  });

  it("is frozen at the even share and leaves the other slots' targets alone", () => {
    const { store } = account();
    const open = scaledSlotTarget(store, DATE, "rest", "meal-2")?.kcal;
    store.days[DATE] = { date: DATE, eaten: { "meal-1": "2026-10-03T08:00:00Z" } };
    expect(frozenEatenShare(store, DATE, "rest", "meal-1")?.kcal).toBeCloseTo(open!, 5);
    expect(scaledSlotTarget(store, DATE, "rest", "meal-2")?.kcal).toBeCloseTo(open!, 5);
    expect(planningSlotTarget(store, DATE, "rest", "meal-2")?.kcal).toBeCloseTo(open!, 5);
  });

  it("offers no open or planning share for the eaten slot itself", () => {
    const { store } = account();
    store.days[DATE] = { date: DATE, eaten: { "meal-1": "2026-10-03T08:00:00Z" } };
    expect(frozenEatenShare(store, DATE, "rest", "meal-1")).toBeDefined();
    expect(scaledSlotTarget(store, DATE, "rest", "meal-1")).toBeUndefined();
    expect(planningSlotTarget(store, DATE, "rest", "meal-1")).toBeUndefined();
  });
});

// An eaten slot must never render empty, even when remaining-budget generation cannot build its
// meal. Production holds timestamp-only eaten marks from before freeze-on-tick (2026-09-27);
// their cards are regenerated on every render. GPT-6 Sol audit on #340.
describe("an eaten slot whose meal can no longer be generated", () => {
  const recipeAllProtein = {
    baseMealId: "recipe:big-bowl", title: "Big protein bowl",
    components: [{ name: "Big protein bowl", qty: 1, unit: "whole" as const, role: "free" as const,
      macros: { kcal: 900, protein: 140, carbs: 60, fat: 30 } }] as [import("@/lib/types").FoodComponent],
  };

  it("keeps the eaten card and its estimated intake when a recipe used all the protein", () => {
    const { store, eligible } = account();
    store.days[DATE] = { date: DATE,
      eaten: { "meal-1": "2026-10-03T08:00:00Z", "meal-2": "2026-10-03T12:30:00Z" },
      consumedSlots: { "meal-2": recipeAllProtein } };
    const day = resolveDay(store, DATE, 0, eligible);
    const breakfast = day.slots.find((slot) => slot.slot === "meal-1")!;
    expect(breakfast.meal).not.toBeNull();
    expect(breakfast.eaten).toBe(true);
    expect(breakfast.eatenAt).toBe("2026-10-03T08:00:00Z");
    // Frozen at the even share of the whole day, not at what the recipe left over.
    const share = frozenEatenShare(store, DATE, "rest", "meal-1")!;
    expect(share.kcal).toBeCloseTo(KCAL / day.slots.length, 5);
    expect(breakfast.macros.kcal).toBeCloseTo(share.kcal, 5);
    expect(breakfast.macros.kcal).toBeGreaterThan(0);
    expect(day.consumed.kcal).toBe(Math.round(900 + share.kcal));
  });

  it("keeps the eaten card when the account's foods can no longer build any meal", () => {
    const { store, eligible } = account();
    for (const food of Object.values(store.foods)) if (food.role === "protein") food.status = "avoid";
    store.days[DATE] = { date: DATE, eaten: { "meal-1": "2026-10-03T08:00:00Z" } };
    const day = resolveDay(store, DATE, 0, eligible);
    const breakfast = day.slots.find((slot) => slot.slot === "meal-1")!;
    expect(breakfast.eaten).toBe(true);
    expect(breakfast.meal).not.toBeNull();
    expect(breakfast.macros.kcal).toBeGreaterThan(0);
    // The other, uneaten slots still show nothing rather than an invented meal.
    expect(day.slots.filter((slot) => slot.slot !== "meal-1").every((slot) => slot.meal === null))
      .toBe(true);
  });

  it("labels the estimate and carries no food components that an edit could save", () => {
    const { store, eligible } = account();
    store.days[DATE] = { date: DATE,
      eaten: { "meal-1": "2026-10-03T08:00:00Z", "meal-2": "2026-10-03T12:30:00Z" },
      consumedSlots: { "meal-2": recipeAllProtein } };
    const breakfast = resolveDay(store, DATE, 0, eligible).slots.find((slot) => slot.slot === "meal-1")!;
    expect(breakfast.meal?.name).toMatch(/estimate/i);
    expect(breakfast.components).toEqual([]);
    expect(breakfast.meal?.components).toEqual([]);
  });

  it("keeps the estimate after a time-only edit (a followPlan shell with no foods)", () => {
    const { store, eligible } = account();
    store.days[DATE] = { date: DATE,
      eaten: { "meal-1": "2026-10-03T08:00:00Z", "meal-2": "2026-10-03T12:30:00Z" },
      consumedSlots: { "meal-2": recipeAllProtein },
      itemOverrides: { "meal-1": { baseMealId: null, components: [], followPlan: true, time: "07:15" } } };
    const day = resolveDay(store, DATE, 0, eligible);
    const breakfast = day.slots.find((slot) => slot.slot === "meal-1")!;
    expect(breakfast.time).toBe("07:15");
    expect(breakfast.meal?.name).toMatch(/estimate/i);
    expect(breakfast.macros.kcal).toBeGreaterThan(0);
    expect(breakfast.eaten).toBe(true);
  });

  it("replaces the estimate, not stacks on it, when a real food is added to the card", () => {
    const { store, eligible } = account();
    const toast = { name: "Toast", qty: 2, unit: "whole" as const, role: "carb" as const,
      macros: { kcal: 160, protein: 6, carbs: 30, fat: 2 } };
    store.days[DATE] = { date: DATE,
      eaten: { "meal-1": "2026-10-03T08:00:00Z", "meal-2": "2026-10-03T12:30:00Z" },
      consumedSlots: { "meal-2": recipeAllProtein },
      itemOverrides: { "meal-1": { baseMealId: "eaten:2026-10-03:meal-1", components: [toast],
        followPlan: false } } };
    const day = resolveDay(store, DATE, 0, eligible);
    const breakfast = day.slots.find((slot) => slot.slot === "meal-1")!;
    expect(breakfast.components.map((part) => part.name)).toEqual(["Toast"]);
    expect(breakfast.macros.kcal).toBe(160);
    expect(day.consumed.kcal).toBe(900 + 160);
  });

  it("still builds the uneaten meals when one protein short and an old eaten mark sinks the day", () => {
    const { store, eligible } = account();
    const slots = resolveDay(store, DATE, 0, eligible).slots.length;
    // Leave exactly one distinct protein fewer than the day has slots.
    const proteins = Object.values(store.foods).filter((food) => food.role === "protein");
    const names = [...new Set(proteins.map((food) => food.name.toLowerCase()))];
    const keep = new Set(names.slice(0, slots - 1));
    for (const food of proteins) if (!keep.has(food.name.toLowerCase())) food.status = "avoid";
    // D5: a protein may repeat in a non-neighbouring slot, so the day is still built.
    expect(resolveDay(store, DATE, 0, eligible).slots.every((slot) => slot.meal !== null)).toBe(true);
    expect(generatedProteinAvailabilityForDay(store, DATE, eligible))
      .toEqual({ available: slots - 1, required: slots - 1 });

    store.days[DATE] = { date: DATE, eaten: { "meal-1": "2026-10-03T08:00:00Z" } };
    const day = resolveDay(store, DATE, 0, eligible);
    const breakfast = day.slots.find((slot) => slot.slot === "meal-1")!;
    expect(breakfast.meal?.name).toMatch(/estimate/i);
    expect(breakfast.eaten).toBe(true);
    expect(day.slots.filter((slot) => slot.slot !== "meal-1").every((slot) => slot.meal !== null
      && slot.components.length > 0)).toBe(true);
    // The spared eaten slot is not counted either.
    expect(generatedProteinAvailabilityForDay(store, DATE, eligible))
      .toEqual({ available: slots - 1, required: slots - 1 });
  });

  it("shows an empty plan slot, not a zero 'Meal 1', after reschedule then untick", () => {
    const { store, eligible } = account();
    store.days[DATE] = { date: DATE, eaten: { "meal-2": "2026-10-03T12:30:00Z" },
      consumedSlots: { "meal-2": recipeAllProtein },
      // The time edit kept the estimate's synthetic id; the tick on meal-1 was then removed.
      itemOverrides: { "meal-1": { baseMealId: "eaten:2026-10-03:meal-1", components: [],
        followPlan: true, time: "07:15" } } };
    const breakfast = resolveDay(store, DATE, 0, eligible).slots.find((slot) => slot.slot === "meal-1")!;
    expect(breakfast.meal).toBeNull();
    expect(breakfast.eaten).toBe(false);
    expect(breakfast.time).toBe("07:15");
  });

  it("does not resurrect a slot the account cleared after eating", () => {
    const { store, eligible } = account();
    store.days[DATE] = { date: DATE, eaten: { "meal-1": "2026-10-03T08:00:00Z" },
      itemOverrides: { "meal-1": { baseMealId: null, components: [], cleared: true } } };
    const day = resolveDay(store, DATE, 0, eligible);
    expect(day.slots.find((slot) => slot.slot === "meal-1")!.meal).toBeNull();
  });
});

describe("eatenEstimateMeal", () => {
  it("says the nutrition is unknown instead of implying 0 kcal when there is no share", () => {
    expect(eatenEstimateMeal(DATE, "meal-1", undefined).name).toMatch(/unknown/i);
    expect(eatenEstimateMeal(DATE, "meal-1", { kcal: 500, protein: 30, carbs: 50, fat: 15 }).name)
      .toMatch(/estimate/i);
  });
});

// A slot that rendered "Nothing planned yet" (an old eaten mark whose meal could not be rebuilt)
// offered "Log what you ate"; the estimate card now brings that slot back, so the log and the
// estimate must not both count. A real log for the slot wins over the guess.
describe("an estimated eaten slot that also has a log for the same slot", () => {
  const recipe = {
    baseMealId: "recipe:big-bowl", title: "Big protein bowl",
    components: [{ name: "Big protein bowl", qty: 1, unit: "whole" as const, role: "free" as const,
      macros: { kcal: 900, protein: 140, carbs: 60, fat: 30 } }] as [import("@/lib/types").FoodComponent],
  };
  const logged = (slot: import("@/lib/types").LoggedFood["slot"]) => ({
    id: `log-${slot}`, foodId: "oats", name: "Oats with berries", slot, portionLabel: "1 bowl",
    qty: 1, grams: 250, macros: { kcal: 450, protein: 15, carbs: 70, fat: 10 },
    at: "2026-10-03T08:05:00Z",
  });
  const day = (extras: ReturnType<typeof logged>[]) => {
    const { store, eligible } = account();
    store.days[DATE] = { date: DATE,
      eaten: { "meal-1": "2026-10-03T08:00:00Z", "meal-2": "2026-10-03T12:30:00Z" },
      consumedSlots: { "meal-2": recipe }, extras };
    return { day: resolveDay(store, DATE, 0, eligible), store };
  };

  it("counts the logged meal once and the estimate not at all", () => {
    const { day: resolved } = day([logged("meal-1")]);
    const breakfast = resolved.slots.find((slot) => slot.slot === "meal-1")!;
    expect(breakfast.eaten).toBe(true);
    expect(breakfast.meal?.name).toMatch(/log/i);
    expect(breakfast.macros.kcal).toBe(0);
    expect(resolved.consumed.kcal).toBe(900 + 450);
  });

  it("still counts the estimate when the log belongs to another slot or is a snack", () => {
    for (const slot of ["meal-3", "snack"] as const) {
      const { day: resolved, store } = day([logged(slot)]);
      const share = frozenEatenShare(store, DATE, "rest", "meal-1")!;
      const breakfast = resolved.slots.find((item) => item.slot === "meal-1")!;
      expect(breakfast.meal?.name).toMatch(/estimate/i);
      expect(resolved.consumed.kcal).toBe(Math.round(900 + share.kcal + 450));
    }
  });
});
