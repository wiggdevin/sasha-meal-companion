/**
 * Onboarding v2 reward preview (2026-10-07 live QA defect 5: the preview listed "chicken breast,
 * white rice, olive oil" while Today then showed "Tofu with potato and avocado"). The preview is
 * Today's own `resolveDay` run over the settings and foods onboarding is about to save, for the
 * date Today will open on, so the two cannot disagree for a new account (no saved days, no eating
 * history; closed food world).
 *
 * `foods` must be the foods the person picked, already filtered by the account's current rules
 * (`starterChoices` / the fresh reread). The preview treats them as verified, as Today will once
 * the server's eligible read confirms them; it writes nothing.
 *
 * Pure. No I/O.
 */
import type { Food } from "@/lib/foods";
import { resolveDay } from "@/lib/resolve";
import { defaultStore } from "@/lib/store";
import type { FoodComponent, Settings } from "@/lib/types";

export type PlanPreviewMeal = {
  /** "Meal 1" … as Today labels it. */
  label: string;
  /** "08:00": the slot clock Today will use. */
  time: string;
  name: string;
  kcal: number;
  proteinG: number;
  components: FoodComponent[];
};

export type PlanPreview = {
  date: string;
  meals: PlanPreviewMeal[];
  /** Slots Today will show empty (nothing coherent fits the picked foods). */
  emptySlots: number;
};

export function onboardingPlanPreview(
  settings: Settings, foods: readonly Food[], date: string,
): PlanPreview {
  const store = defaultStore();
  store.settings = { ...settings, ruleReviewReady: true };
  store.foods = Object.fromEntries(foods.filter((food) => food.status === "eats")
    .map((food) => [food.id, { ...food }]));
  const day = resolveDay(store, date, 0, new Set(Object.keys(store.foods)));
  const meals = day.slots.filter((slot) => slot.meal !== null && slot.components.length > 0)
    .map((slot) => ({
      label: slot.label, time: slot.time, name: slot.meal!.name,
      kcal: Math.round(slot.macros.kcal), proteinG: Math.round(slot.macros.protein),
      components: slot.components.map((part) => ({ ...part, macros: { ...part.macros } })),
    }));
  return { date, meals, emptySlots: day.slots.length - meals.length };
}
