/**
 * The water tile's press (owner, 2026-10-03: "If the user long-holds and starts swiping right, show
 * a bar that updates in ounces or cups rapidly. The farther they slide right, the higher the count
 * goes, so they don't tap 40 times."). Pure: the clock and the callbacks are injected, so the rule
 * is tested without a browser; components/today/WaterTile.tsx wires it to pointer events.
 *
 * - A press that lifts before the hold matures, without moving, is a tap: the tile's click adds one
 *   step (8 oz, a cup, 237 ml — one stored cup).
 * - Moving past the slop before the hold matures abandons the press, so a scroll or a stray swipe
 *   starting on the tile never logs water.
 * - Held for `SCRUB_HOLD_MS`, the scrub opens. Sliding right adds whole steps, faster the farther
 *   the finger goes; sliding left takes them back, down to removing what the day already holds.
 * - Lifting commits the pending amount once (one set-total write, never N taps); lifting at zero,
 *   Escape or a cancelled pointer closes it with no change.
 */
import { MAX_CUPS } from "@/lib/today/water-gesture";
import { formatWater, formatWaterDelta, waterNumber, type WaterUnit } from "@/lib/water-units";

export const SCRUB_HOLD_MS = 350;
/** Finger travel allowed before the hold matures; past it the press is not ours. */
export const SCRUB_SLOP_PX = 10;
/** Near the start, one step per this many pixels. */
export const SCRUB_STEP_PX = 24;
/** The distance over which the quadratic term adds four more steps: the acceleration. */
export const SCRUB_ACCEL_PX = 100;

/**
 * Whole steps for a horizontal travel of `dx` px from where the hold matured. Linear near the start
 * (one step per 24 px) plus a quadratic term, so 100 px gives 8 steps, 150 px 15 and 200 px 24:
 * a slow slide counts one cup at a time, a long one reaches a big bottle in a thumb's reach.
 */
export function scrubSteps(dx: number): number {
  if (!Number.isFinite(dx)) return 0;
  const d = Math.abs(dx);
  const steps = Math.floor(d / SCRUB_STEP_PX + 4 * (d / SCRUB_ACCEL_PX) ** 2);
  return dx < 0 ? -steps : steps;
}

/** The pending amount the day can take: never below removing all of it, never past the cap. */
export function clampPending(steps: number, cups: number, max: number = MAX_CUPS): number {
  const current = Math.max(0, Math.floor(Number.isFinite(cups) ? cups : 0));
  return Math.min(Math.max(0, max - current), Math.max(-current, Math.trunc(steps)));
}

export type ScrubPorts = {
  /** The hold matured: open the bar at a pending amount of zero. */
  onHold: () => void;
  /** The pending amount changed (one call per step crossed). */
  onStep: (pending: number) => void;
  /** Lifted with a non-zero pending amount. */
  onCommit: (pending: number) => void;
  /** Closed with no change: lifted at zero, Escape, or a cancelled pointer. */
  onCancel: () => void;
};

export type ScrubClock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/** What a lift turned out to be. "none": the press had already been abandoned (moved too far). */
export type ScrubOutcome = "tap" | "commit" | "cancel" | "none";

type Phase = "idle" | "pressing" | "scrubbing";

const browserClock: ScrubClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createWaterScrub(ports: ScrubPorts, clock: ScrubClock = browserClock) {
  let phase: Phase = "idle";
  let timer: unknown = null;
  let startX = 0;
  let startY = 0;
  let holdX = 0;
  let cups = 0;
  let max = MAX_CUPS;
  let pending = 0;

  function clear() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  return {
    get phase() { return phase; },
    get pending() { return pending; },
    /** Pointer down at (x, y) while the day holds `dayCups`. */
    down(x: number, y: number, dayCups: number, cap: number = MAX_CUPS) {
      if (phase !== "idle") return;
      phase = "pressing";
      startX = x;
      startY = y;
      holdX = x;
      cups = dayCups;
      max = cap;
      pending = 0;
      timer = clock.setTimeout(() => {
        timer = null;
        phase = "scrubbing";
        ports.onHold();
      }, SCRUB_HOLD_MS);
    },
    move(x: number, y: number) {
      if (phase === "pressing") {
        if (Math.hypot(x - startX, y - startY) > SCRUB_SLOP_PX) {
          clear();
          phase = "idle";
        } else {
          holdX = x;
        }
        return;
      }
      if (phase !== "scrubbing") return;
      const next = clampPending(scrubSteps(x - holdX), cups, max);
      if (next === pending) return;
      pending = next;
      ports.onStep(next);
    },
    up(): ScrubOutcome {
      if (phase === "pressing") {
        clear();
        phase = "idle";
        return "tap";
      }
      if (phase === "scrubbing") {
        phase = "idle";
        const amount = pending;
        pending = 0;
        if (amount !== 0) { ports.onCommit(amount); return "commit"; }
        ports.onCancel();
        return "cancel";
      }
      return "none";
    },
    cancel() {
      const wasScrubbing = phase === "scrubbing";
      clear();
      phase = "idle";
      pending = 0;
      if (wasScrubbing) ports.onCancel();
    },
  };
}

export type WaterScrub = ReturnType<typeof createWaterScrub>;

/**
 * The bar's live line: "+48 oz → 96 / 128 oz", "−1 cup → 3 / 8 cups", or "+2 cups → 6 cups" with
 * no goal. `cups` is the day's logged amount and `pending` the steps being added, both in cups.
 */
export function scrubParts(cups: number, pending: number, goal: number, unit: WaterUnit): { delta: string; after: string } {
  const total = Math.max(0, cups + pending);
  return {
    delta: formatWaterDelta(pending, unit),
    after: goal > 0 ? `${waterNumber(total, unit)} / ${formatWater(goal, unit)}` : formatWater(total, unit),
  };
}

export function scrubText(cups: number, pending: number, goal: number, unit: WaterUnit): string {
  const { delta, after } = scrubParts(cups, pending, goal, unit);
  return `${delta} \u2192 ${after}`;
}
