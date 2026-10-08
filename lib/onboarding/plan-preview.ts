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
 * The settings carry the UNSAVED target candidate (`buildCompletedSettings`), which has no server
 * revision, and target resolution rightly answers needs_profile for that (`targetRevisionOn`,
 * lib/targets/revision.ts), so Today never plans from an unsaved number. The preview accepts the
 * candidate explicitly, as the revision in force on the preview date, inside its own throwaway
 * store only (`previewTargetSettings`): nothing here is saved, returned or shared with Today.
 *
 * Pure. No I/O.
 */
import type { Food } from "@/lib/foods";
import { resolveDay } from "@/lib/resolve";
import { defaultStore } from "@/lib/store";
import type { FoodComponent, Settings, TargetRevision } from "@/lib/types";

/** The revision number the preview gives the candidate. The server numbers revisions from 1, so a
 *  0 can never be mistaken for a saved one. */
export const PREVIEW_TARGET_REVISION = 0;

/**
 * Preview only: the candidate as a dated revision in force on `date`, with no history and no id.
 * A candidate that already is a saved revision (a re-opened setup) is left as it is. Returns a new
 * object; the caller's settings are never changed.
 */
function previewTargetSettings(settings: Settings, date: string): Settings {
  const candidate = settings.activeTargetProfile;
  if (!candidate || typeof candidate.revision === "number") return settings;
  const preview = {
    ...candidate, revision: PREVIEW_TARGET_REVISION, effectiveFrom: date,
  } as TargetRevision;
  delete preview.id;
  return { ...settings, activeTargetProfile: preview, targetHistory: [], targetHistorySince: null };
}

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
  store.settings = { ...previewTargetSettings(settings, date), ruleReviewReady: true };
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
