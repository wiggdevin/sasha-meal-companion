/**
 * A061 through the live phone generator: a date's "Quick meals" mark (`StoredDay.floorDay`)
 * reaches `resolveDay`, which then shows quick plates (lib/meals/day.ts `QuickRanking`). Without
 * the mark the day is unchanged; eaten slots keep what was eaten.
 */
import { describe, expect, it } from "vitest";
import { StampedEligibleSet } from "@/lib/foods/eligible-client";
import { foodRulesKey } from "@/lib/foods/rule-marks";
import { foodRulesEpoch } from "@/lib/foods/rules-epoch";
import { plateMinutes, QUICK_MINUTES } from "@/lib/plan/prep-minutes";
import { resolveDay } from "@/lib/resolve";
import { defaultStore } from "@/lib/store";
import type { Food } from "@/lib/foods";
import type { ResolvedDay, Store } from "@/lib/types";
import { F } from "@/tests/helpers/meal-foods";

const macros = { kcal: 1800, protein: 120, carbs: 190, fat: 60 };
const FOODS = [F.eggs, F.yogurt, F.oats, F.toast, F.tuna, F.chicken, F.tofu, F.banana, F.rice, F.broccoli,
  F.oliveOil, F.bread, F.tomato, F.lentils];
const DATES = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));

function account(foods: Food[]): { store: Store; eligible: StampedEligibleSet } {
  const store = defaultStore();
  store.foods = Object.fromEntries(foods.map((food) => [food.id, { ...food }]));
  store.settings = { ...store.settings, onboardedAt: "2026-09-26T12:00:00Z", trainingWeekdays: [],
    ruleReviewReady: true, mealsPerDay: 3, activeTargetProfile: { revision: 1, training: macros, rest: macros,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  const eligible = new StampedEligibleSet(foods.map((food) => food.id), new Map(), foodRulesKey(store.settings),
    foodRulesEpoch(), undefined, Date.now());
  return { store, eligible };
}

const byName = (store: Store) => new Map(Object.values(store.foods).map((food) => [food.name.toLowerCase(), food]));
function quickSlots(day: ResolvedDay, store: Store): number {
  const foods = byName(store);
  return day.slots.filter((slot) => slot.components.length > 0 && plateMinutes(slot.components
    .map((part) => foods.get(part.name.toLowerCase()) ?? { name: part.name })) <= QUICK_MINUTES).length;
}

describe("A061: the Quick meals mark changes the generated day", () => {
  it("a marked date shows more quick plates, and clearing the mark restores the day", () => {
    const { store, eligible } = account(FOODS);
    let changed = 0;
    for (const date of DATES) {
      const plain = resolveDay(store, date, 0, eligible);
      store.days[date] = { ...(store.days[date] ?? { date }), floorDay: true };
      const quick = resolveDay(store, date, 0, eligible);
      expect(quick.isFloorDay).toBe(true);
      expect(quick.slots.map((slot) => slot.slot)).toEqual(plain.slots.map((slot) => slot.slot));
      expect(quickSlots(quick, store)).toBeGreaterThanOrEqual(quickSlots(plain, store));
      if (JSON.stringify(quick.slots) !== JSON.stringify(plain.slots)) changed += 1;
      store.days[date] = { ...store.days[date], floorDay: false };
      expect(JSON.stringify(resolveDay(store, date, 0, eligible).slots)).toBe(JSON.stringify(plain.slots));
    }
    expect(changed).toBeGreaterThan(0);
  });

  it("leaves an eaten slot and a saved meal exactly as they were", () => {
    const { store, eligible } = account(FOODS);
    const date = DATES.find((day) => {
      const plain = resolveDay(store, day, 0, eligible);
      store.days[day] = { date: day, floorDay: true };
      const quick = resolveDay(store, day, 0, eligible);
      delete store.days[day];
      return plain.slots.filter((slot, i) => JSON.stringify(slot.components)
        !== JSON.stringify(quick.slots[i].components)).length >= 2;
    }) as string;
    expect(date).toBeDefined();
    const plain = resolveDay(store, date, 0, eligible);
    const [eaten, saved] = plain.slots.filter((slot) => slot.components.length > 0);
    store.days[date] = { date,
      eaten: { [eaten.slot]: `${date}T08:00:00.000Z` },
      itemOverrides: {
        [eaten.slot]: { baseMealId: eaten.meal?.id ?? null, components: eaten.components, title: eaten.meal?.name },
        [saved.slot]: { baseMealId: saved.meal?.id ?? null, components: saved.components, title: saved.meal?.name },
      },
    };
    const before = resolveDay(store, date, 0, eligible);
    store.days[date] = { ...store.days[date], floorDay: true };
    const after = resolveDay(store, date, 0, eligible);
    for (const id of [eaten.slot, saved.slot]) {
      const was = before.slots.find((slot) => slot.slot === id);
      const now = after.slots.find((slot) => slot.slot === id);
      expect(now?.components).toEqual(was?.components);
      expect(now?.meal?.name).toBe(was?.meal?.name);
      expect(now?.eaten).toBe(was?.eaten);
    }
  });
});
