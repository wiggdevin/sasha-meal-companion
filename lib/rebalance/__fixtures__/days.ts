/**
 * Test fixtures for the rebalance panel's lib (Phase 19 R1). Stores are resolved through the real
 * `resolveDay` and projected through `projectPanelSlots`, so every fixture is a day Today renders.
 * Three meals at 08:00, 12:30 and 18:30 (the default schedule) on a rest day.
 */
import { projectPanelSlots, type PanelSlot } from "@/lib/plan/panel-slots";
import { resolveDay } from "@/lib/resolve";
import { defaultStore } from "@/lib/store";
import type {
  FoodComponent, LoggedFood, LoggedItem, Macros, ResolvedDay, SlotId, SlotOverride, Store,
} from "@/lib/types";

export const DATE = "2026-10-06";

export function macrosOf(kcal: number): Macros {
  return { kcal, protein: kcal / 20, carbs: kcal / 8, fat: kcal / 45 };
}

/** An account with a target revision of `kcal` on both day types, or none (`null`). */
export function account(kcal: number | null = 2000, meals = 3): Store {
  const store = defaultStore();
  const day = kcal === null ? undefined : macrosOf(kcal);
  store.settings = { ...store.settings, trainingWeekdays: [], mealsPerDay: meals, ruleReviewReady: true,
    activeTargetProfile: day ? { revision: 1, training: day, rest: day,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } : null } as Store["settings"];
  return store;
}

export function line(name: string, kcal: number): FoodComponent {
  return { name, qty: 1, unit: "whole", role: "free", macros: macrosOf(kcal) };
}

/** A saved meal edit (the user's own meal for this date). */
export function saved(kcal: number, title = "Saved meal", extra: Partial<SlotOverride> = {}): SlotOverride {
  return { baseMealId: null, title, components: kcal > 0 ? [line(title, kcal)] : [], ...extra };
}

/** One logged item: reported and/or calculated energy; neither means unknown. */
export function item(energy: { reported?: number; calculated?: number; legacyKcal?: number } = {},
  id = "item"): LoggedItem {
  const value = (amount: number) => ({ amount, unit: "kcal", basis: "per_100g" as const });
  const snapshot: LoggedItem["snapshot"] = {
    protein: { amount: 25, unit: "g", basis: "per_100g" },
    ...(energy.reported !== undefined ? { energy_kcal: value(energy.reported) } : {}),
    ...(energy.calculated !== undefined ? { energy_kcal_calc: value(energy.calculated) } : {}),
  } as LoggedItem["snapshot"];
  return { id, seq: 1, food_ref_id: "ref", grams: 100, qty: 1, unit: "g", snapshot,
    foodId: "f", name: "Food", portionLabel: "100 g", macros: macrosOf(energy.legacyKcal ?? 0) };
}

/** A log entry; `items: undefined` is a legacy entry with no items. */
export function entry(id: string, items: LoggedItem[] | undefined, slot?: SlotId | "snack",
  extra: Partial<LoggedFood> = {}): LoggedFood {
  const legacy = items?.reduce((sum, row) => sum + row.macros.kcal, 0) ?? 0;
  return { id, foodId: "f", name: "Logged", portionLabel: "1", qty: 1, grams: 100,
    macros: macrosOf(legacy), at: `${DATE}T12:00:00Z`, ...(items ? { items } : {}),
    ...(slot ? { slot } : {}), ...extra };
}

export const eatenAt = (slot: SlotId) => ({ [slot]: `${DATE}T12:00:00Z` });

/** Resolve the date and project its panel slots from the same store, as Today does. */
export function build(store: Store, date = DATE): { day: ResolvedDay; slots: PanelSlot[] } {
  const day = resolveDay(store, date);
  return { day, slots: projectPanelSlots(day, store.days[date]) };
}

export const slotOf = (slots: readonly PanelSlot[], id: SlotId): PanelSlot =>
  slots.find((slot) => slot.slot === id)!;

/** Local minutes of "HH:MM". */
export const at = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return { date: DATE, minutes: h * 60 + m };
};
