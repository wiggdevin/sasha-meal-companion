/**
 * The numbers behind "Skip Meal 5 and move its ~500 kcal into Meal 4?" (lib/plan/skip-preview.ts)
 * and the override a skip writes and lifts (lib/plan/skip-override.ts).
 */
import { describe, expect, it } from "vitest";
import { defaultStore } from "@/lib/store";
import { plannedSlotIds } from "@/lib/resolve";
import { previewSkip } from "@/lib/plan/skip-preview";
import { clearMeal, isSkipped, restoreMeal } from "@/lib/plan/skip-override";
import { removeMeal } from "@/lib/today/meal-actions";
import type { FoodComponent, Macros, SlotOverride, Store } from "@/lib/types";

const DATE = "2026-10-03";
const DAY: Macros = { kcal: 2400, protein: 180, carbs: 240, fat: 80 };

function account(): Store {
  const store = defaultStore();
  store.settings = { ...store.settings, trainingWeekdays: [], ruleReviewReady: true,
    activeTargetProfile: { revision: 1, training: DAY, rest: DAY,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  return store;
}

const saved = (kcal: number): SlotOverride => ({ baseMealId: null, title: "Saved", components: [
  { name: "food", qty: 1, unit: "g", role: "free", macros: { kcal, protein: 30, carbs: 50, fat: 10 } } as FoodComponent] });

describe("previewSkip", () => {
  it("moves an open meal's share evenly into the other open meals", () => {
    const store = account();
    const slots = plannedSlotIds(store, DATE, "rest");
    const n = slots.length;
    const preview = previewSkip(store, DATE, slots.at(-1)!);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.freedKcal).toBe(Math.round(DAY.kcal / n));
    const last = preview.rows.find((row) => row.slot === slots.at(-1))!;
    expect(last).toMatchObject({ state: "skipped", kcalAfter: 0 });
    const first = preview.rows.find((row) => row.slot === slots[0])!;
    expect(first.kcalBefore).toBe(Math.round(DAY.kcal / n));
    expect(first.kcalAfter).toBe(Math.round(DAY.kcal / (n - 1)));
    expect(preview.absorbedBy).toHaveLength(n - 1);
  });

  it("keeps saved meals at their size and gives a saved meal's kcal to the open ones", () => {
    const store = account();
    const slots = plannedSlotIds(store, DATE, "rest");
    const [first, second, ...open] = slots;
    store.days[DATE] = { date: DATE, itemOverrides: { [first]: saved(600), [second]: saved(900) } };
    const preview = previewSkip(store, DATE, second);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.freedKcal).toBe(900);
    expect(preview.rows.find((row) => row.slot === first)).toMatchObject(
      { state: "planned", kcalBefore: 600, kcalAfter: 600 });
    const grown = preview.rows.find((row) => row.slot === open[0])!;
    expect(grown.kcalBefore).toBe(Math.round((DAY.kcal - 1500) / open.length));
    expect(grown.kcalAfter).toBe(Math.round((DAY.kcal - 600) / open.length));
  });

  it("says when no open meal takes the share", () => {
    const store = account();
    const slots = plannedSlotIds(store, DATE, "rest");
    store.days[DATE] = { date: DATE, itemOverrides: Object.fromEntries(slots.map((id) => [id, saved(400)])) };
    const preview = previewSkip(store, DATE, slots[0]);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.absorbedBy).toEqual([]);
  });

  it("refuses an eaten meal, a skipped meal, a slot not on the plan and an account with no target", () => {
    const store = account();
    const slots = plannedSlotIds(store, DATE, "rest");
    store.days[DATE] = { date: DATE, eaten: { [slots[0]]: `${DATE}T08:00:00Z` },
      itemOverrides: { [slots[1]]: clearMeal(undefined, null) } };
    expect(previewSkip(store, DATE, slots[0])).toMatchObject({ ok: false });
    expect(previewSkip(store, DATE, slots[1])).toMatchObject({ ok: false });
    expect(previewSkip(store, DATE, "meal-6")).toMatchObject({ ok: false });
    store.settings = { ...store.settings, activeTargetProfile: undefined } as Store["settings"];
    expect(previewSkip(store, DATE, slots[2])).toMatchObject({ ok: false });
  });
});

describe("restoreMeal", () => {
  it("lifts a Clear back to the plan, keeping the date's time and an added slot", () => {
    expect(restoreMeal(clearMeal(undefined, "m1"))).toBeNull();
    expect(restoreMeal(clearMeal({ baseMealId: "m1", components: [], time: "19:30" }, "m1")))
      .toEqual({ baseMealId: "m1", components: [], followPlan: true, time: "19:30" });
    expect(restoreMeal(clearMeal({ baseMealId: null, components: [], added: true, followPlan: true,
      time: "21:00" }, null)))
      .toEqual({ baseMealId: null, components: [], followPlan: true, time: "21:00", added: true });
  });

  it("lifts a delete and keeps the meal underneath", () => {
    const meal = saved(500);
    expect(restoreMeal(removeMeal(meal, null))).toEqual({ ...meal });
  });

  it("knows what counts as skipped", () => {
    expect(isSkipped(clearMeal(undefined, null))).toBe(true);
    expect(isSkipped(removeMeal(undefined, null))).toBe(true);
    expect(isSkipped(saved(300))).toBe(false);
    expect(isSkipped(undefined)).toBe(false);
  });
});
