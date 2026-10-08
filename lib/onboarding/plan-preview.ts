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
 * A returning account (final Sol review BLOCK) keeps its own foods: Today plans from the
 * account's full verified Eats, not the starter picks alone, so the preview runs over the
 * account's store as the save leaves it — its foods with each pick's mark applied by normalized
 * name (the membership rule), its saved days — and verifies the picks plus whichever existing
 * Eats the account's last server read verified (`account.verified`, Today's own set).
 *
 * Pure. No I/O.
 */
import type { Food } from "@/lib/foods";
import { normalizeFoodName } from "@/lib/foods/normalize";
import { StampedEligibleSet } from "@/lib/foods/eligible-client";
import { foodRulesKey, mealEvidenceOf } from "@/lib/foods/rule-marks";
import { resolveDay } from "@/lib/resolve";
import { defaultStore } from "@/lib/store";
import type { FoodComponent, Settings, Store, TargetRevision } from "@/lib/types";

/** The account as it stands before the save, for a returning account's preview. */
export type PreviewAccount = {
  store: Store;
  /** Today's verified Eats for the account's existing foods (the server's eligible read), or
   *  null when that read failed: then only the picks count as verified. */
  verified: ReadonlySet<string> | null;
};

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

/** The account's foods with each pick applied by normalized name, the way the save's membership
 *  ops apply it: the pick at its own id, and every same-name food of the account set to its mark. */
function foodsAfterSave(existing: Record<string, Food>, picks: readonly Food[]): Record<string, Food> {
  const marks = new Map(picks.map((food) => [normalizeFoodName(food.name), food.status]));
  const foods: Record<string, Food> = Object.fromEntries(Object.entries(existing).map(([id, food]) => {
    const mark = marks.get(normalizeFoodName(food.name));
    return [id, mark ? { ...food, status: mark } : { ...food }];
  }));
  for (const pick of picks) foods[pick.id] = { ...pick };
  return foods;
}

/** The picks plus the existing Eats the server verified, carrying that read's evidence and stamp
 *  when it was judged under the rules the preview plans with. */
function previewVerified(foods: Record<string, Food>, picks: readonly Food[],
  verified: ReadonlySet<string> | null, settings: Settings): ReadonlySet<string> {
  const ids = [...picks.filter((food) => food.status === "eats").map((food) => food.id),
    ...[...(verified ?? [])].filter((id) => foods[id]?.status === "eats")];
  if (verified instanceof StampedEligibleSet && !verified.revoked
    && verified.rulesKey === foodRulesKey(settings)) {
    return new StampedEligibleSet(ids, verified.marks, verified.rulesKey, verified.epoch,
      mealEvidenceOf(verified), verified.verifiedAt, verified.accountId, verified.sentences);
  }
  return new Set(ids);
}

export function onboardingPlanPreview(
  settings: Settings, foods: readonly Food[], date: string, account?: PreviewAccount,
): PlanPreview {
  const store: Store = account ? { ...account.store } : defaultStore();
  store.settings = { ...previewTargetSettings(settings, date), ruleReviewReady: true };
  store.foods = account ? foodsAfterSave(account.store.foods, foods)
    : Object.fromEntries(foods.filter((food) => food.status === "eats").map((food) => [food.id, { ...food }]));
  const verified = account ? previewVerified(store.foods, foods, account.verified, store.settings)
    : new Set(Object.keys(store.foods));
  const day = resolveDay(store, date, 0, verified);
  const meals = day.slots.filter((slot) => slot.meal !== null && slot.components.length > 0)
    .map((slot) => ({
      label: slot.label, time: slot.time, name: slot.meal!.name,
      kcal: Math.round(slot.macros.kcal), proteinG: Math.round(slot.macros.protein),
      components: slot.components.map((part) => ({ ...part, macros: { ...part.macros } })),
    }));
  return { date, meals, emptySlots: day.slots.length - meals.length };
}
