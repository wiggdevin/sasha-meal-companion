/**
 * The shared slate builder for every coach-composed meal surface (Phase 18 W6 UI,
 * docs/specs/phase-18-open-world-foods.md §W6, §7.2): the Plan sheet's ideas
 * (`components/PlanSheet.tsx`, `components/plan/IdeaCard.tsx`) and the coach's own suggestion
 * cards (`components/coach/ShellComposedCards.tsx`, `components/coach/blocks/food_ideas.tsx`, both
 * through `components/CoachComposedCard.tsx`) all render the same `ComposedMeal` shape, so they
 * share this one builder instead of three copies of the same slate logic.
 *
 * `ComposedItem` (lib/coach/compose.ts) carries an optional `foodKey` (PR #463, Phase 18 W6
 * UI-NEEDS 1): the account's own food or a catalog food the search hit resolved to, already
 * validated with `isFoodKey` server-side (`itemFoodKey`) and again by the stored composed-meal
 * schema (`lib/coach/ui-blocks.ts`). An item with no resolvable key (a free-text dish name, or one
 * the server could not ground) simply has no `foodKey`; `composedMealKey` reads it straight off
 * the item and re-checks it with `isFoodKey` as defense in depth, never trusting the wire shape on
 * its own.
 *
 * Pure. No I/O — the caller sends the result through `sendFoodSignals`.
 */

import {
  PLAN_SHEET_RANKING_VERSION, SIGNAL_SLATE_MAX, SUGGESTION_CARD_RANKING_VERSION,
  type SignalSurface,
} from "@/lib/foods/signals";
import { isFoodKey } from "@/lib/meals/food-key";
import type { Occasion } from "@/lib/meals/occasion";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { FoodSignalInput } from "@/lib/foods/signals-client";

/** Re-exported for this file's existing callers: the server only accepts a `rankingVersion` in its
 *  own `SIGNAL_RANKING_VERSIONS` allowlist, so these must be the lib's issued constants, never a
 *  hand-written string here. */
export { PLAN_SHEET_RANKING_VERSION, SUGGESTION_CARD_RANKING_VERSION };

/** A composed meal's food key, when one of its items carries a resolvable one (its own `foodKey`,
 *  re-validated with `isFoodKey`). `undefined` for a meal with no grounded item — a free-text dish
 *  name, or one the server could not resolve to an account or catalog food. */
export function composedMealKey(meal: Pick<ComposedMeal, "items">): string | undefined {
  for (const item of meal.items) {
    if (isFoodKey(item.foodKey)) return item.foodKey;
  }
  return undefined;
}

export type ComposedMealSignalInput = {
  slateId: string;
  surface: SignalSurface;
  kind: "picked" | "not_this" | "added";
  /** Every meal shown together, in display order. */
  slate: readonly ComposedMeal[];
  /** The meal the tap was about. */
  chosen: ComposedMeal;
  occasion: Occasion;
  rankingVersion: string;
};

/** The one event for a tap on a composed-meal card, or `[]` when the chosen meal (or the slate it
 *  came from) has no resolvable food key. */
export function composedMealSignalEvents(input: ComposedMealSignalInput): FoodSignalInput[] {
  const offeredKeys: string[] = [];
  for (const meal of input.slate) {
    const key = composedMealKey(meal);
    if (key && !offeredKeys.includes(key) && offeredKeys.length < SIGNAL_SLATE_MAX) offeredKeys.push(key);
  }
  const chosenKey = composedMealKey(input.chosen);
  if (!chosenKey || !offeredKeys.includes(chosenKey)) return [];
  return [{ slateId: input.slateId, surface: input.surface, kind: input.kind, occasion: input.occasion,
    chosenKey, offeredKeys, rankingVersion: input.rankingVersion }];
}
