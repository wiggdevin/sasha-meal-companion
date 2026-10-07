"use client";

/**
 * The client half of the registry: each kind's write and its Undo, delegating to the apply module
 * that already owns that write. The mapped type makes this table exhaustive — a kind registered in
 * lib/coach/actions/index.ts without a binding here does not compile.
 *
 * It lives apart from the specs so that importing an action schema never imports the write layer
 * (see the note on ApplyBinding in lib/coach/actions/spec.ts).
 */

import { applyLogWater, applyLogWeight, undoLogWater, undoLogWeight }
  from "@/lib/coach/apply-body";
import {
  applyDeleteEntry, applyMoveEntry, applySaveRecipe, undoDeleteEntry, undoMoveEntry, undoSaveRecipe,
} from "@/lib/coach/apply-entries";
import { applyLog, undoLog } from "@/lib/coach/apply-log";
import { applyFoodListMark, undoFoodListMark } from "@/lib/coach/apply-prefs";
import { applySetTargets, applyUpdateProfile, undoSettingsAction }
  from "@/lib/coach/apply-profile";
import { applyShiftSchedule, undoShiftSchedule } from "@/lib/coach/apply-schedule";
import { applyAddToShoppingList, undoAddToShoppingList } from "@/lib/coach/apply-shopping";
import { applyRestoreSlot, applySkipSlot, undoSkipSlot } from "@/lib/coach/apply-skip";
import { applyMove, applySetSlotMeal, applySlot, undoMove, undoSlot } from "@/lib/coach/apply-slot";
import type { RegisteredTypes } from "@/lib/coach/actions";
import type { ApplyBinding, SpecTypes } from "@/lib/coach/actions/spec";

type Bindings = { [D in RegisteredTypes as D["kind"]]: ApplyBinding<D> };

const foodList = { apply: applyFoodListMark, undo: undoFoodListMark };
const slotItem = { apply: applySlot, undo: undoSlot };

/** Each apply receives `(action, ctx)`; the ones that need no context ignore the second argument. */
const BINDINGS: Bindings = {
  log_meal: { apply: applyLog, undo: undoLog },
  add_slot_item: slotItem,
  remove_slot_item: slotItem,
  set_slot_item: slotItem,
  move_slot: { apply: applyMove, undo: undoMove },
  add_to_avoid: foodList,
  remove_from_avoid: foodList,
  set_slot_meal: { apply: applySetSlotMeal, undo: undoSlot },
  delete_entry: { apply: applyDeleteEntry, undo: undoDeleteEntry },
  move_entry: { apply: applyMoveEntry, undo: undoMoveEntry },
  save_recipe: { apply: applySaveRecipe, undo: undoSaveRecipe },
  shift_schedule: { apply: applyShiftSchedule, undo: undoShiftSchedule },
  log_water: { apply: applyLogWater, undo: undoLogWater },
  log_weight: { apply: applyLogWeight, undo: (token) => undoLogWeight(token) },
  update_profile: { apply: applyUpdateProfile, undo: (token) => undoSettingsAction(token) },
  set_targets: { apply: applySetTargets, undo: (token) => undoSettingsAction(token) },
  add_to_eats: foodList,
  remove_from_eats: foodList,
  add_to_shopping_list: { apply: applyAddToShoppingList, undo: undoAddToShoppingList },
  skip_slot: { apply: applySkipSlot, undo: undoSkipSlot },
  restore_slot: { apply: applyRestoreSlot, undo: undoSkipSlot },
};

/** The binding for a kind, or undefined for a kind this build does not know (design §8.5). */
export function applyBindingFor(kind: string): ApplyBinding<SpecTypes> | undefined {
  return Object.hasOwn(BINDINGS, kind)
    ? (BINDINGS as Record<string, ApplyBinding<SpecTypes>>)[kind] : undefined;
}
