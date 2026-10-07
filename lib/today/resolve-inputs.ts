/**
 * The one builder of Today's `resolveDay` inputs (Phase 19 R2, Sol re-plan). Today's main resolve,
 * its `planInputs` callback and the "Rebalance my day" hook all call it, so the panel can never
 * resolve a different day from the one Today shows. It alone applies the two live overrides:
 * - the accepted-recipe overlay, only when recipe access is on and the accepted rows are for the
 *   viewed date (rows for another date are stale for this view and are ignored);
 * - the rule-review readiness the page holds now (`starterGate === "ready"`), which replaces the
 *   stored setting for this resolve, because generation reads it (lib/resolve.ts).
 * Pure: no store read, no clock.
 */
import { withAcceptedRecipeSelections } from "@/lib/recipes/accepted-overlay";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { Store } from "@/lib/types";

/** What the page knows right now that the stored day does not carry. */
export type TodayLive = {
  /** Eats the server verified for generation; undefined while that read is in flight. */
  eligibleFoodIds?: ReadonlySet<string>;
  /** The accepted recipe selections the page last read, with the date they were read for. */
  accepted: { date: string; rows: readonly AcceptedRecipeSelection[] } | null;
  recipeAccessEnabled: boolean;
  /** The page's current rule-review readiness (`starterGate === "ready"`). */
  ruleReviewReady: boolean;
};

export type TodayResolveInputs = {
  /** The store as resolved: overlay applied, readiness overridden. Reuse it for the same day's notes. */
  store: Store;
  /** The exact `resolveDay` arguments, water included. */
  args: [store: Store, date: string, waterCups: number, eligibleFoodIds: ReadonlySet<string> | undefined];
};

export function todayResolveInputs(store: Store, viewedDate: string, live: TodayLive): TodayResolveInputs {
  const selected = live.recipeAccessEnabled && live.accepted?.date === viewedDate
    ? withAcceptedRecipeSelections(store, live.accepted.rows) : store;
  const projected: Store = { ...selected, settings: { ...store.settings, ruleReviewReady: live.ruleReviewReady } };
  return { store: projected, args: [projected, viewedDate, 0, live.eligibleFoodIds] };
}
