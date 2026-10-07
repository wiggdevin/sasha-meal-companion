/**
 * Skipping a meal for one date is Today's own Clear: the same `clearMeal` override, written through
 * the same `saveItemOverride` plan-day op. A cleared slot is fixed at zero, so its share goes to the
 * day's open meals (lib/plan/slot-share.ts), and the card stays visible and can be planned again.
 *
 * Pure.
 */

import { clearMeal } from "@/lib/today/meal-actions";
import type { SlotOverride } from "@/lib/types";

export { clearMeal };

/** True when the slot holds a skip (Clear) or a delete for that date. */
export function isSkipped(override: SlotOverride | undefined): boolean {
  return !!override && (override.cleared === true || override.removed === true);
}

/**
 * The override that brings a skipped (cleared) or deleted meal back for one date, or null to drop
 * the override and follow the plan. A delete keeps its meal underneath, so lifting `removed`
 * restores it; a Clear kept no foods, so the slot follows the plan again, keeping its date-specific
 * time and, for an added meal, the slot itself. Anything else is returned unchanged.
 */
export function restoreMeal(previous: SlotOverride | undefined): SlotOverride | null {
  if (!previous) return null;
  if (previous.removed) {
    const lifted = { ...previous };
    delete lifted.removed;
    return lifted.cleared ? restoreMeal(lifted) : lifted;
  }
  if (!previous.cleared) return previous;
  if (!previous.added && !previous.time) return null;
  return { baseMealId: previous.baseMealId, components: [], followPlan: true,
    ...(previous.time ? { time: previous.time } : {}), ...(previous.added ? { added: true } : {}) };
}

/**
 * A restore that always leaves something to compare (review t4r11 #1): the restored override, or —
 * where `restoreMeal` would drop the override and follow the plan — a followPlan shell with no
 * food, which resolves exactly like no override (lib/resolve.ts, the time-only shell rule). Either
 * way it carries its own `mutationId`, so skip → restore → skip → restore leaves the slot unequal
 * to what the first restore wrote, and that restore's Undo refuses instead of bringing back the
 * old skip.
 */
export function restoreMealMarked(
  previous: SlotOverride | undefined, mutationId: string = crypto.randomUUID(),
): SlotOverride {
  const restored = restoreMeal(previous)
    ?? { baseMealId: previous?.baseMealId ?? null, components: [], followPlan: true };
  return { ...restored, mutationId };
}
