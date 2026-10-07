/**
 * The swap sheet's own slate builder (Phase 18 W6 UI, docs/specs/phase-18-open-world-foods.md
 * §W6, §7.2): turns the meal being replaced and the alternatives shown in
 * `components/MealSwapSheet.tsx` into the `swapped_away` + `picked` pair `lib/foods/signals.ts`
 * expects, sharing one slate and one `slateId` per opening of the sheet.
 *
 * A `SwapAlternative`'s own food key (lib/meals/food-key.ts `componentFoodKey`) is its protein
 * line's: `option.proteinKey` is a real `Food.id` for every alternative source (a composed plate's
 * anchor, a recipe's or a saved meal's protein ingredient — `lib/today/swap-alternatives.ts`
 * resolves each through the same account `foods` record this component already holds), so looking
 * it up there gives a real wire key for all three sources, not only generated plates. The
 * currently-shown meal has no such back-reference (`Meal.components` carries no raw food id), so
 * its key comes from its protein component's own `foodKey` line when the engine set one
 * (`lib/meals/size.ts` `generatedComponent`); a custom or edited meal without that line has no
 * resolvable key and `swapped_away` is skipped for it (never invented).
 *
 * Pure. No I/O — the caller sends the result through `sendFoodSignals`.
 */

import { SIGNAL_SLATE_MAX, SWAP_SHEET_RANKING_VERSION } from "@/lib/foods/signals";
import { componentFoodKey } from "@/lib/meals/food-key";
import type { Occasion } from "@/lib/meals/occasion";
import type { SwapAlternative } from "@/lib/today/swap-alternatives";
import type { Food } from "@/lib/foods";
import type { FoodComponent } from "@/lib/types";
import type { FoodSignalInput } from "@/lib/foods/signals-client";

/** Re-exported for this file's existing callers: the swap sheet's own slate is never pure
 *  `rankPlates` order (`lib/today/swap-alternatives.ts` lists saved recipes and saved meals FIRST,
 *  unranked, ahead of the generated plates), so it names this allowlisted identifier
 *  (`lib/foods/signals.ts` `SIGNAL_RANKING_VERSIONS`) instead of the ranking engine's own
 *  `RANKING_VERSION` ("o2.1"), which would misstate a saved alternative's place in the carousel as
 *  ranked when it was not. One name covers every swap slate, mixed or not — W6 PR #466. */
export { SWAP_SHEET_RANKING_VERSION };

/** A swap option's food key: its protein ingredient's account food, resolved the same way the
 *  ranking engine resolves a generated plate's anchor. Undefined when the protein ingredient is
 *  not (or no longer) one of the account's own foods — an anchorless snack, or a stale option. */
export function swapOptionKey(option: Pick<SwapAlternative, "proteinKey">, foods: Record<string, Food>): string | undefined {
  const food = foods[option.proteinKey];
  return food ? componentFoodKey(food) : undefined;
}

/**
 * The currently-shown meal's food key: its protein line's own `foodKey`, when the engine set one.
 *
 * Known edge case (Sol r3 WARN), not fixed here: this line is read verbatim off a PERSISTED meal
 * component, which can be old. The route now owner-checks a `food:<uuid>` key against the
 * caller's own `user_foods` rows (W6 PR #466, `lib/server/food-signals.ts`), so a stale account
 * food id is caught; a `food:<bundled-id>` key is checked against the current universe file
 * (`lib/food-db.json`), so a persisted key naming a bundled food since removed from it is still
 * rejected server-side — taking the whole `swapped_away` + `picked` pair down with it, since both
 * share this slate. There is no client-side freshness check available (the phone never loads
 * either table, by design), so this stays an accepted, rare telemetry gap rather than something
 * this helper can close.
 */
export function currentMealKey(components: readonly FoodComponent[]): string | undefined {
  return components.find((component) => component.role === "protein")?.foodKey;
}

export type SwapSignalsInput = {
  /** One id per showing of the sheet; shared by both events below. */
  slateId: string;
  /** The meal being replaced, as currently shown. */
  currentComponents: readonly FoodComponent[];
  /** Every alternative the carousel showed, in display order. */
  shownOptions: readonly SwapAlternative[];
  /** The option the user tapped "Swap to this" on. */
  chosenOption: SwapAlternative;
  /** The account's foods, as already held by `MealSwapSheet` (`foods` prop). */
  foods: Record<string, Food>;
  occasion: Occasion;
};

/**
 * The `swapped_away` + `picked` pair for one swap. `offeredKeys` is every shown option's key, in
 * display order, followed by the replaced meal's key (when resolvable), deduped and capped at
 * `SIGNAL_SLATE_MAX`. The shown options go first: the carousel can show up to 8 alternatives
 * (`lib/today/swap-alternatives.ts`), exactly `SIGNAL_SLATE_MAX`, so putting the replaced meal's
 * key first could silently push the last visible, tappable option out of the capped slate — a
 * real pick the user could see and tap would then fail its own "chosen key in slate" check. The
 * replaced meal, by contrast, is not itself a tap target here; losing its key only drops the
 * `swapped_away` event, never a `picked` one. Either event is left out when its own key cannot be
 * resolved, or (for `picked`) when the chosen option's key is not actually in the built slate — a
 * stale or out-of-slate tap is never reported as if it were offered.
 */
export function swapSignalEvents(input: SwapSignalsInput): FoodSignalInput[] {
  const offeredKeys: string[] = [];
  const addKey = (key: string | undefined) => {
    if (!key || offeredKeys.includes(key) || offeredKeys.length >= SIGNAL_SLATE_MAX) return;
    offeredKeys.push(key);
  };
  for (const option of input.shownOptions) addKey(swapOptionKey(option, input.foods));
  const swappedAwayKey = currentMealKey(input.currentComponents);
  addKey(swappedAwayKey);
  const chosenKey = swapOptionKey(input.chosenOption, input.foods);

  const events: FoodSignalInput[] = [];
  if (swappedAwayKey && offeredKeys.includes(swappedAwayKey)) {
    events.push({ slateId: input.slateId, surface: "swap_sheet", kind: "swapped_away",
      occasion: input.occasion, chosenKey: swappedAwayKey, offeredKeys,
      rankingVersion: SWAP_SHEET_RANKING_VERSION });
  }
  if (chosenKey && offeredKeys.includes(chosenKey)) {
    events.push({ slateId: input.slateId, surface: "swap_sheet", kind: "picked",
      occasion: input.occasion, chosenKey, offeredKeys,
      rankingVersion: SWAP_SHEET_RANKING_VERSION });
  }
  return events;
}
