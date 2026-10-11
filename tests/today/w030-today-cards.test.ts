/**
 * W030 (audit 2026-10-10 F18): Today meal-card edge cases in the resolver, the swap sheet and the
 * plate rotation.
 *   A064: a ticked slot whose followPlan snapshot a log suppressed still reads as eaten.
 *   A065: the swap sheet never offers the meal already on the card.
 *   A062: the anchor date-variety stays in (0.7, 1] on dates before the rotation epoch.
 */
import { describe, expect, it } from "vitest";
import { defaultStore } from "@/lib/store";
import { resolveDay } from "@/lib/resolve";
import { EATEN_LOGGED_NAME } from "@/lib/plan/eaten-estimate";
import { rankPlates } from "@/lib/meals/plate";
import { swapAlternatives } from "@/lib/today/swap-alternatives";
import type { Food } from "@/lib/foods";
import type { FoodComponent, LoggedFood, Macros, Store } from "@/lib/types";
import { eats, F, MAIN } from "@/tests/helpers/meal-foods";

const DATE = "2026-10-04";
const DAY: Macros = { kcal: 1800, protein: 135, carbs: 180, fat: 60 };

function account(): Store {
  const store = defaultStore();
  store.settings = { ...store.settings, trainingWeekdays: [], mealsPerDay: 3, ruleReviewReady: true,
    activeTargetProfile: { revision: 1, training: DAY, rest: DAY,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  return store;
}

const salmon: FoodComponent = { name: "Salmon", qty: 1, unit: "whole", role: "free",
  macros: { kcal: 450, protein: 40, carbs: 0, fat: 30 } } as FoodComponent;
const plateLog: LoggedFood = { id: "log-1", foodId: "f", name: "Plate", portionLabel: "1 plate", qty: 1,
  grams: 300, macros: { kcal: 800, protein: 40, carbs: 100, fat: 20 }, at: `${DATE}T19:00:00Z`, slot: "meal-3" };

describe("A064: a ticked snapshot slot with its own log", () => {
  it("reads as eaten, counted in the log, and counts the log once", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { "meal-3": `${DATE}T19:30:00Z` },
      itemOverrides: { "meal-3": { baseMealId: "plan-dinner", components: [salmon], followPlan: true, time: "19:30" } },
      extras: [plateLog] };
    const day = resolveDay(store, DATE);
    const dinner = day.slots.find((slot) => slot.slot === "meal-3")!;
    expect(dinner.eaten).toBe(true);
    expect(dinner.meal?.name).toBe(EATEN_LOGGED_NAME);
    expect(dinner.components).toEqual([]);
    expect(dinner.macros.kcal).toBe(0);
    expect(day.consumed.kcal).toBe(800);
  });

  it("keeps the snapshot when no log is filed under the slot", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { "meal-3": `${DATE}T19:30:00Z` },
      itemOverrides: { "meal-3": { baseMealId: "plan-dinner", components: [salmon], followPlan: true, time: "19:30" } } };
    const dinner = resolveDay(store, DATE).slots.find((slot) => slot.slot === "meal-3")!;
    expect(dinner.eaten).toBe(true);
    expect(dinner.components.map((part) => part.name)).toEqual(["Salmon"]);
  });
});

describe("A065: the swap sheet leaves out the current meal", () => {
  const foods = Object.fromEntries(Object.values(eats(F.chicken, F.tuna, F.lentils, F.tofu, F.rice,
    F.broccoli, F.oliveOil, F.avocado)).map((food) => [food.id, food])) as Record<string, Food>;
  const base = { slot: "meal-2" as const, target: MAIN, foods, clock: "12:30", date: DATE };

  it("drops a row holding the card's foods, whatever its id or portions", () => {
    const all = swapAlternatives(base);
    expect(all.length).toBeGreaterThan(1);
    const current = all[0]!;
    const resized = current.components.map((part) => ({ ...part, qty: part.qty * 1.1 }));
    const rows = swapAlternatives({ ...base, currentMealId: `suggested:${DATE}:meal-2`,
      currentComponents: resized });
    expect(rows.map((row) => row.name)).not.toContain(current.name);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("changes nothing when the card holds no foods", () => {
    expect(swapAlternatives({ ...base, currentComponents: [] })).toEqual(swapAlternatives(base));
  });
});

describe("A062: date variety before the rotation epoch", () => {
  const foods = Object.values(eats(F.chicken, F.tuna, F.lentils, F.tofu, F.rice, F.broccoli, F.oliveOil));
  const scores = (date: string) => new Map(rankPlates({ date, slot: "meal-2", occasion: "lunch",
    target: MAIN, foods }).plates.map((plate) => [plate.key, plate.score]));

  it("never scores a plate above its best score on any post-epoch date", () => {
    const best = new Map<string, number>();
    for (let day = 1; day <= 28; day += 1) {
      for (const [key, score] of scores(`2026-02-${String(day).padStart(2, "0")}`)) {
        best.set(key, Math.max(best.get(key) ?? 0, score));
      }
    }
    for (const date of ["2025-12-26", "2025-06-01", "2024-02-29"]) {
      for (const [key, score] of scores(date)) {
        expect(score, `${date} ${key}`).toBeLessThanOrEqual((best.get(key) ?? 0) + 1e-9);
      }
    }
  });
});
