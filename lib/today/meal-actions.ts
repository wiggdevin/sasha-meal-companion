import { shiftTime, slotListFor } from "@/lib/plan";
import { plannedSlotIds } from "@/lib/resolve";
import type { DayType, ResolvedSlot, SlotId, SlotOverride, Store } from "@/lib/types";

const MEALS: SlotId[] = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"];

/** The first extra slot absent on this date; removing an added card makes it available again. */
export function nextMealSlot(store: Store, date: string, dayType: DayType): SlotId | null {
  const regular = new Set(slotListFor(dayType, store.settings, date));
  const visible = new Set(plannedSlotIds(store, date, dayType));
  return MEALS.find((id) => !regular.has(id) && !visible.has(id)) ?? null;
}

/** A new meal follows the last visible meal by 2h30, stopping at 9:30 pm. */
export function addedMealTime(slots: ResolvedSlot[]): string {
  const previous = slots.filter((slot) => slot.slot.startsWith("meal-"))
    .map((slot) => slot.time).sort().at(-1) ?? "12:00";
  const shifted = shiftTime(previous, 150);
  return shifted > "21:30" ? "21:30" : shifted;
}

/** Clear keeps the user's date-specific time, but no dish title or planned components. */
export function clearMeal(previous: SlotOverride | undefined, baseMealId: string | null): SlotOverride {
  return { baseMealId: previous ? previous.baseMealId : baseMealId, components: [],
    ...(previous?.time ? { time: previous.time } : {}),
    ...(previous?.added ? { added: true } : {}), cleared: true };
}

/** A removal masks the card on one date without erasing its authored snapshot. */
export function removeMeal(previous: SlotOverride | undefined, baseMealId: string | null): SlotOverride {
  return { ...previous, baseMealId: previous ? previous.baseMealId : baseMealId,
    components: previous?.components ?? [], removed: true };
}

/** Re-adding a removed extra meal restores its authored choice; a new extra follows the plan. */
export function restoreAddedMeal(previous: SlotOverride | undefined, time: string): SlotOverride {
  if (previous?.removed && previous.added) {
    const restored = { ...previous };
    delete restored.removed;
    return restored;
  }
  return { baseMealId: null, components: [], added: true, followPlan: true, time };
}
