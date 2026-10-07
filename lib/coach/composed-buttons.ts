/**
 * The buttons a composed meal card offers (components/CoachComposedCard.tsx): Log it and Save as
 * recipe always, and Put it in <slot> for the slot the wish named, else the first pending meal —
 * plus, when the card offers a choice of more than one pending meal, each of those.
 *
 * Pure. `record_coach_undo` (migration 20261210090300) mirrors it in SQL to accept a record for a
 * card's button only when the card offers that button (review t4r6 #3); tests hold the two to the
 * same fixtures. The card can read its slots from here too.
 */
import type { ComposedMeal } from "@/lib/coach/compose";

export type ComposedButtons = { kinds: ("log_meal" | "set_slot_meal" | "save_recipe")[]; slots: string[] };

export function composedButtons(
  meal: Pick<ComposedMeal, "slot" | "pendingSlots"> & { items?: readonly unknown[] },
): ComposedButtons {
  // A card with no foods renders nothing, so it offers no button (review t4r7 #5).
  if (!meal.items || meal.items.length === 0) return { kinds: [], slots: [] };
  const offered = meal.pendingSlots ?? [];
  const first = meal.slot ?? offered[0]?.slot ?? null;
  const slots = first === null ? []
    : [...new Set([first, ...(offered.length > 1 ? offered.map((row) => row.slot) : [])])];
  return {
    kinds: slots.length > 0 ? ["log_meal", "set_slot_meal", "save_recipe"] : ["log_meal", "save_recipe"],
    slots,
  };
}
