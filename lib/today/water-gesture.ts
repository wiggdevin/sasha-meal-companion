/**
 * The water dial's press (the reviewer, 2026-09-18): a tap adds one cup; a hold opens a slider and the
 * finger then drags left or right to set the count. Pure — the clock and the callbacks are
 * injected, so the rule is tested without a browser. `components/WaterDial.tsx` wires it to
 * pointer events.
 */

/** A press held this long is an adjust, not a tap. */
export const HOLD_MS = 450;
/** Finger travel for one cup while adjusting. */
export const PX_PER_CUP = 28;
/** Nobody drinks more cups than this in a day; the slider stops here. */
export const MAX_CUPS = 30;

export function cupsFromDrag(startCups: number, dx: number, goal = 0): number {
  const next = Math.round(startCups + dx / PX_PER_CUP);
  // OD10: the dial snaps to the day's goal when the finger lands within a cup of it.
  if (goal > 0 && Math.abs(next - goal) <= 1 && goal <= MAX_CUPS) return goal;
  return Math.min(MAX_CUPS, Math.max(0, next));
}

export type WaterPressPorts = {
  /** A short press: add one cup. */
  onTap: () => void;
  /** The hold matured: open the slider at `cups`. */
  onHoldStart: (cups: number) => void;
  /** The finger moved while adjusting: the slider now shows `cups`. */
  onAdjust: (cups: number) => void;
  /** The finger lifted while adjusting: commit `cups` (or nothing when unchanged). */
  onCommit: (cups: number | null) => void;
  /** The press was cancelled (scroll, second pointer, blur): close without a change. */
  onCancel: () => void;
};

export type WaterPressClock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type Phase = "idle" | "pressing" | "adjusting";

const browserClock: WaterPressClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createWaterPress(ports: WaterPressPorts, clock: WaterPressClock = browserClock) {
  let phase: Phase = "idle";
  let timer: unknown = null;
  let startX = 0;
  let startCups = 0;
  let shown = 0;

  function clear() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  return {
    get phase() { return phase; },
    /** Pointer down at `x` while the dial shows `cups`. */
    down(x: number, cups: number) {
      if (phase !== "idle") return;
      phase = "pressing";
      startX = x;
      startCups = cups;
      shown = cups;
      timer = clock.setTimeout(() => {
        timer = null;
        phase = "adjusting";
        ports.onHoldStart(startCups);
      }, HOLD_MS);
    },
    move(x: number, goal = 0) {
      if (phase !== "adjusting") return;
      const next = cupsFromDrag(startCups, x - startX, goal);
      if (next === shown) return;
      shown = next;
      ports.onAdjust(next);
    },
    up() {
      if (phase === "pressing") {
        clear();
        phase = "idle";
        ports.onTap();
        return;
      }
      if (phase === "adjusting") {
        phase = "idle";
        ports.onCommit(shown === startCups ? null : shown);
      }
    },
    cancel() {
      if (phase === "idle") return;
      clear();
      phase = "idle";
      ports.onCancel();
    },
  };
}

export type WaterPress = ReturnType<typeof createWaterPress>;

/**
 * While the slider is open the page must not select text or scroll under the finger: iOS starts
 * its own text selection at about the same moment the hold matures, and it lands on the dial's
 * numerals and labels (the reviewer, 2026-09-19: "it is highlighting things it shouldn't"). This is the
 * same guard the meal cards' hold uses (components/useMealReschedule.ts). Returns the release.
 */
export function guardSelection(doc: Document): () => void {
  const previous = doc.body.style.userSelect;
  doc.body.style.userSelect = "none";
  doc.getSelection()?.removeAllRanges();
  const block = (event: Event) => { if (event.cancelable) event.preventDefault(); };
  doc.addEventListener("selectstart", block);
  doc.addEventListener("touchmove", block, { passive: false });
  return () => {
    doc.body.style.userSelect = previous;
    doc.removeEventListener("selectstart", block);
    doc.removeEventListener("touchmove", block);
  };
}
