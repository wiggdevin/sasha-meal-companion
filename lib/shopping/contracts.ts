/**
 * Shared Shopping contracts (UI makeover W0). The planner draft, its checks and the preview input
 * live here so the Shopping components, the client and later workstreams read one definition;
 * `components/ShoppingControls.tsx` and `components/ShoppingView.tsx` re-export them for older
 * importers. These exports are frozen: add to them, never remove or change one.
 */
import type { IngredientIdentity, ShoppingPeriod } from "@/lib/shopping/types";

/**
 * The planner's editable period fields. `title` is optional (1-60 characters, null untitled);
 * the period routes store it, the preview's strict draft never carries it.
 */
export type ShoppingDraft = Pick<ShoppingPeriod, "startDate" | "endDate" | "timezone" | "people" |
  "mealCoverage" | "mode" | "effort" | "maxActiveMinutes" | "variety" |
  "budgetAmount" | "currency" | "locale" | "lockMode"> & { title?: string | null };

/**
 * What a preview is asked for. `excludeRecipeIds` (optional) names recipes the planner drops
 * before scoring; `previewShopping` sends it only when it is non-empty.
 */
export type ShoppingPreviewInput = {
  draft: ShoppingDraft;
  basket: IngredientIdentity[];
  excludeRecipeIds?: string[];
};

/** One saved, named and dated list, as the saved-list switcher shows it. */
export type SavedListSummary = {
  id: string;
  title: string | null;
  startDate: string;
  endDate: string;
  itemCount: number;
  checkedCount: number;
};

/** A nearby store on the build flow's map. `distanceM` is metres from the searched point. */
export type PlaceStore = { id: string; name: string; lat: number; lon: number; distanceM: number };

/** A typed place resolved to a point. */
export type GeocodeResult = { lat: number; lon: number; label: string };

export function realCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Why a draft cannot be previewed (or saved as a blank list, which needs no meals), in the words
 * the planner shows beside its button; null when it can.
 */
export function draftProblem(draft: ShoppingDraft, { needMeals = true }: { needMeals?: boolean } = {}): string | null {
  if (!realCalendarDate(draft.startDate) || !realCalendarDate(draft.endDate)) return "Enter real calendar dates.";
  if (draft.endDate < draft.startDate) return "Through must be on or after From.";
  if (!Number.isInteger(draft.people) || draft.people < 1) return "People must be a whole number, 1 or more.";
  if (needMeals && !draft.mealCoverage.length) return "Pick at least one meal.";
  return null;
}

function shiftDate(date: string, days: number): string {
  if (!realCalendarDate(date)) return "";
  const value = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(value.getTime())) return "";
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function defaultShoppingDraft(startDate: string, timezone: string): ShoppingDraft {
  return { startDate, endDate: shiftDate(startDate, 6), timezone, people: 1,
    mealCoverage: ["dinner"], mode: "balanced", effort: "standard", maxActiveMinutes: null,
    variety: "balanced", budgetAmount: null, currency: null, locale: null, lockMode: "none" };
}
