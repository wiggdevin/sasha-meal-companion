/**
 * The card of an eaten slot that nothing describes: no recipe snapshot and no saved edit.
 * Production still holds timestamp-only eaten marks from before freeze-on-tick (2026-09-27), and
 * a tick on a slot that showed no meal saves nothing either.
 *
 * Such a slot is frozen (2026-10-04 audit): it is never regenerated and never returns to the open
 * pool, so a later skip, log or edit elsewhere cannot rewrite a meal already eaten. It counts as
 * one of two things, the same on the card, in the day's total and in every other slot's share
 * (lib/plan/slot-share.ts):
 *   - a log filed under the slot is the record: the card counts nothing and the log counts once;
 *   - otherwise its frozen share (frozenEatenShare), shown as an estimate.
 * The card name says which, and it carries NO food components: only its macros. So an edit on the
 * card can never save the estimate as a food (adding a real food replaces the estimate rather than
 * stacking on it), and no generator, shopping or protein rule sees it.
 */
import type { FoodComponent, Macros, Meal, SlotId, SlotOverride, StoredDay } from "@/lib/types";

/** Slots ticked eaten with nothing saved to describe them: no recipe snapshot and no frozen edit
 *  (absent, or a followPlan shell with no food). They are frozen and shown as eatenEstimateMeal.
 *  The same shell rule resolveDay uses: an eaten slot is never generated, so it has no base meal,
 *  and a followPlan override that holds food describes it (eatenPlanSnapshot). */
export function undescribedEatenSlots(day: StoredDay | undefined, ids: readonly SlotId[]): Set<SlotId> {
  return new Set(ids.filter((id) => {
    const override = day?.itemOverrides?.[id];
    return day?.eaten?.[id] && !consumedSnapshot(day, id)
      && (!override || (override.followPlan === true && override.components.length === 0));
  }));
}

/**
 * The foods a followPlan override saved for an eaten slot with no recipe snapshot. A time-only
 * edit stores the plan the card showed then ("a safe snapshot for older clients", lib/types.ts),
 * and an eaten slot is never regenerated, so that snapshot is the best record of the meal: the
 * card shows it and the day counts it (2026-10-04 re-audit, MAJOR 1). Null when it holds no food.
 */
export function eatenPlanSnapshot(day: StoredDay | undefined, id: SlotId): FoodComponent[] | null {
  const override = day?.itemOverrides?.[id];
  return day?.eaten?.[id] && !consumedSnapshot(day, id) && override?.followPlan === true
    && !override.cleared && override.components.length > 0 ? override.components : null;
}

/** The Plan panel's "counted in your log" meal (lib/today/count-log-once.ts loggedShell). */
export function isLoggedShell(override: SlotOverride | undefined): boolean {
  return !!override && !override.followPlan && !override.cleared && override.components.length === 0
    && override.title === EATEN_LOGGED_NAME;
}

/**
 * The eaten recipe snapshot that counts for a slot, if any. Once the Plan panel has filed a log as
 * this slot's record (the logged shell), the log is the only record: a snapshot taken when the
 * recipe was ticked no longer counts, on the card or in any share (2026-10-04 re-audit, MAJOR 2).
 */
export function consumedSnapshot(day: StoredDay | undefined, id: SlotId) {
  if (!day?.eaten?.[id] || isLoggedShell(day.itemOverrides?.[id])) return undefined;
  return day.consumedSlots?.[id];
}

/** True when a log entry is filed under this slot (a snack log never is). */
export function slotHasOwnLog(day: Pick<StoredDay, "extras"> | undefined, slot: SlotId): boolean {
  return day?.extras?.some((entry) => entry.slot === slot) ?? false;
}

/**
 * `eatenPlanSnapshot`, but suppressed once a log is filed under the same slot: a log is always
 * the record for an eaten slot, so a time-edit snapshot and a log on that slot must never both
 * count (2026-10-05 audit, MAJOR 4). The card, the day's total and every other slot's share use
 * this, not the raw snapshot, so they agree.
 */
export function eatenPlanSnapshotIfUnlogged(day: StoredDay | undefined, id: SlotId): FoodComponent[] | null {
  return slotHasOwnLog(day, id) ? null : eatenPlanSnapshot(day, id);
}

export const EATEN_ESTIMATE_NAME = "Eaten meal (estimate)";
/** No target revision means no share to estimate from: say so instead of implying 0 kcal. */
export const EATEN_UNKNOWN_NAME = "Eaten meal (nutrition unknown)";

/** A log for this slot already counts what was eaten: the card stays, the guess counts nothing. */
export const EATEN_LOGGED_NAME = "Eaten meal (counted in your log)";

const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

/**
 * `day` is the stored day the estimate belongs to. When it holds a log entry for this same slot
 * (the slot rendered "Nothing planned yet" and offered "Log what you ate" before estimates
 * existed), that log is the real record and the card counts nothing, so the meal is counted once.
 * `share` is the slot's frozen share (lib/plan/slot-share.ts frozenEatenShare).
 */
export function eatenEstimateMeal(date: string, slot: SlotId, share: Macros | undefined,
  day?: Pick<StoredDay, "extras">): Meal {
  const logged = slotHasOwnLog(day, slot);
  const name = logged ? EATEN_LOGGED_NAME : share ? EATEN_ESTIMATE_NAME : EATEN_UNKNOWN_NAME;
  return { id: `eaten:${date}:${slot}`, name, slot, prepMinutes: 0, tags: [], components: [],
    macros: share && !logged ? { ...share } : { ...ZERO } };
}
