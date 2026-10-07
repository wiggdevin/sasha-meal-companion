/**
 * The left swipe on a meal card, as a finger distance mapped to how far the card actually moves.
 * Clear shows first and the card catches there (a sticky detent: the next few dozen pixels of
 * finger travel barely move it, with a tick on arrival); past it Delete shows and the card catches
 * again; past that second catch a release deletes. The tray colours follow the same distances.
 */

/** Card travel at which Clear is fully shown, and at which Clear + Delete are fully shown. */
export const CLEAR_AT = 80;
export const DELETE_AT = 160;
/** Finger travel each catch holds the card for, and how much of it the card follows. */
const HOLD = [36, 48] as const;
const HOLD_RATE = 0.22;
/** Extra finger travel past the second catch before a release deletes. */
const DELETE_PAST = 24;

/** Finger distance where each stage begins: Clear caught, Delete caught, delete armed. */
function stops(width: number) {
  const clear = CLEAR_AT;
  const afterClear = clear + HOLD[0];
  const del = afterClear + (DELETE_AT - CLEAR_AT - HOLD[0] * HOLD_RATE);
  const afterDelete = del + HOLD[1];
  const armed = Math.max(afterDelete + DELETE_PAST, Math.max(1, width) * 0.6);
  return { clear, afterClear, del, afterDelete, armed };
}

/** How far the card moves for a finger distance (both positive, leftwards). */
export function swipeTravel(distance: number, width: number): number {
  const d = Math.max(0, distance);
  const s = stops(width);
  if (d <= s.clear) return d;
  if (d <= s.afterClear) return CLEAR_AT + (d - s.clear) * HOLD_RATE;
  const caughtClear = CLEAR_AT + HOLD[0] * HOLD_RATE;
  if (d <= s.del) return caughtClear + (d - s.afterClear);
  if (d <= s.afterDelete) return DELETE_AT + (d - s.del) * HOLD_RATE;
  return Math.min(Math.max(1, width), DELETE_AT + HOLD[1] * HOLD_RATE + (d - s.afterDelete));
}

/** 0 none, 1 Clear caught, 2 Delete caught, 3 a release deletes. A rise is worth a haptic tick. */
export function swipeStage(distance: number, width: number): 0 | 1 | 2 | 3 {
  const s = stops(width);
  if (distance >= s.armed) return 3;
  if (distance >= s.del) return 2;
  if (distance >= s.clear) return 1;
  return 0;
}

/** Where a released left swipe settles. */
export function leftSwipeOutcome(distance: number, width: number): "none" | "clear" | "actions" | "delete" {
  const stage = swipeStage(distance, width);
  if (stage === 3) return "delete";
  const travel = swipeTravel(distance, width);
  if (travel >= (CLEAR_AT + DELETE_AT) / 2) return "actions";
  if (travel >= CLEAR_AT / 2) return "clear";
  return "none";
}

/** How strongly each action is shown (0 faint and see-through … 1 full colour) at a card travel. */
export function trayStrength(travel: number): { clear: number; del: number } {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return { clear: clamp(travel / CLEAR_AT), del: clamp((travel - CLEAR_AT) / (DELETE_AT - CLEAR_AT)) };
}
