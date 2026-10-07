/**
 * Today's presentation decisions (FluidVoice UI recovery, 2026-09-28). Pure: every threshold is
 * owned here, the components only wire pointer and click events to these answers. Nothing in this
 * file writes a plan, a log or a target — it decides what the screen shows.
 */

/** A press held this long is a long press (the macro detail toggle, the calendar handle). */
export const LONG_PRESS_MS = 450;
/** Finger travel that turns a press into a drag and cancels a pending long press. */
export const PRESS_SLOP_PX = 8;
/** A press held this long before moving is a calendar gesture, not a scroll. */
export const CALENDAR_HOLD_MS = LONG_PRESS_MS;
/** Downward travel that snaps the month grid open once the hold has matured. */
export const CALENDAR_EXPAND_PX = 48;
/** Upward travel and speed (px/ms) that read as a flick closed. */
export const CALENDAR_COLLAPSE_PX = 24;
export const CALENDAR_COLLAPSE_VELOCITY = 0.5;

/** A left swipe past this reveals Clear; past the second threshold it dismisses the card. */
export const SWIPE_REVEAL_PX = 64;
export const SWIPE_DISMISS_PX = 160;
/** One axis must beat the other by this factor before a drag counts; a diagonal counts as neither. */
export const GESTURE_DOMINANCE = 2;
/** Horizontal travel must beat vertical by this factor, so a diagonal scroll never dismisses. */
export const SWIPE_DOMINANCE = GESTURE_DOMINANCE;

/** How long a pointer tap waits for a second tap before it counts as a single. */
export const DOUBLE_TAP_MS = 220;

export function calendarDragDecision(
  deltaY: number, velocityY: number, heldMs: number,
): "expand" | "collapse" | null {
  if (deltaY <= -CALENDAR_COLLAPSE_PX && velocityY <= -CALENDAR_COLLAPSE_VELOCITY) return "collapse";
  if (heldMs >= CALENDAR_HOLD_MS && deltaY >= CALENDAR_EXPAND_PX) return "expand";
  return null;
}

export function swipeDismissDecision(deltaX: number, deltaY: number): "reveal" | "dismiss" | null {
  const left = -deltaX;
  if (left <= 0 || left < Math.abs(deltaY) * SWIPE_DOMINANCE) return null;
  if (left >= SWIPE_DISMISS_PX) return "dismiss";
  if (left >= SWIPE_REVEAL_PX) return "reveal";
  return null;
}

/** One key per account, viewed date and card: a dismissal never leaks to another of any of them. */
export function todayDismissalKey(accountId: string, date: string, cardId: string): string {
  return `smc:u:${accountId}:today-dismissed:${date}:${cardId}`;
}

const QUARTER_HOURS: readonly string[] = Object.freeze(Array.from({ length: 96 }, (_, index) =>
  `${String(Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}`));

/** Every quarter hour of a day, "00:00" through "23:45". */
export function quarterHours(): readonly string[] {
  return QUARTER_HOURS;
}

/**
 * Tells a single tap from a double tap on the same control. A keyboard activation (`detail` 0)
 * runs the single action at once — no hidden timing for keyboard users. A pointer single waits
 * `delayMs`; a second click in that window cancels it and runs the double action once.
 */
export function createTapDisambiguator(onSingle: () => void, onDouble: () => void,
  delayMs: number = DOUBLE_TAP_MS): { click(detail: number): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    click(detail: number) {
      if (detail === 0) { cancel(); onSingle(); return; }
      if (detail === 1) {
        cancel();
        timer = setTimeout(() => { timer = null; onSingle(); }, delayMs);
        return;
      }
      if (detail === 2) { cancel(); onDouble(); }
    },
    cancel,
  };
}

/** A drag whose vertical travel dominates; the calendar gestures ignore every other drag. */
export function isVerticalDrag(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaY) > 0 && Math.abs(deltaY) >= Math.abs(deltaX) * GESTURE_DOMINANCE;
}
