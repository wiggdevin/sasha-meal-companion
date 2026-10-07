"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import {
  animate, useMotionValue, useTransform, type AnimationPlaybackControls, type MotionValue, type ValueAnimationTransition,
} from "motion/react";
import { EASE_OUT, INSTANT, MORPH, SPRINGS } from "@/lib/design/motion";

/**
 * The Day card's faces box (components/today/DayCard.tsx): its live height as a motion value.
 * Between face changes the box takes its content's height (the month grows, an explainer opens)
 * and the value follows it. On a change the box is held at the height it had and springs to the
 * new face's own height; a change that interrupts one carries its speed on.
 */
export function useFacesHeight(ref: RefObject<HTMLElement | null>) {
  const height = useMotionValue(0);
  const running = useRef<AnimationPlaybackControls | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    height.jump(el.offsetHeight);
    const unsubscribe = height.on("change", (value) => {
      if (running.current) el.style.height = `${value}px`;
    });
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => { if (!running.current) height.jump(el.offsetHeight); }) : null;
    observer?.observe(el);
    return () => {
      unsubscribe();
      observer?.disconnect();
      running.current?.stop();
      running.current = null;
    };
  }, [ref, height]);

  /** The new face's own height, read with the box released for a moment. Call it inside a layout
   *  effect so nothing paints in between. */
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return 0;
    const held = el.style.height;
    el.style.height = "";
    const natural = el.offsetHeight;
    el.style.height = held;
    return natural;
  }, [ref]);

  /** Springs the box from `from` to `to` and resolves once it has settled; without motion, or with
   *  nothing to travel, the box takes its new height at once. */
  const spring = useCallback((from: number, to: number, { delay, reduce }: { delay: number; reduce: boolean }) => {
    const el = ref.current;
    if (!el) return Promise.resolve();
    if (reduce || Math.abs(to - from) < 1) {
      running.current?.stop();
      running.current = null;
      el.style.height = "";
      height.jump(to);
      return Promise.resolve();
    }
    el.style.height = `${from}px`;
    if (!running.current) height.jump(from);
    return new Promise<void>((resolve) => {
      const controls = animate(height, to, {
        ...SPRINGS.smooth, delay,
        onComplete: () => {
          if (running.current !== controls) return;
          running.current = null;
          el.style.height = "";
          height.jump(el.offsetHeight);
          resolve();
        },
      });
      running.current = controls;
    });
  }, [ref, height]);

  return { height, measure, spring };
}

export type EdgeAnchor = { line: MotionValue<number>; riding: MotionValue<number>; y: MotionValue<number> };

/**
 * Something placed against the card's lower edge: the orb. Riding (its state before the first face
 * change), it moves with that edge. Held, it stays on one line in the faces' frame while the card's
 * height springs past it, so a leaving orb fades where it was instead of sliding away with the edge,
 * and an arriving one springs to the ring's centre on its own. `y` is the offset to draw it at.
 */
export function useEdgeAnchor(facesHeight: MotionValue<number>): EdgeAnchor {
  const line = useMotionValue(0);
  const riding = useMotionValue(1);
  const y = useTransform([line, facesHeight, riding], ([at, height, ride]: number[]) => (ride ? 0 : at - height));
  return useMemo(() => ({ line, riding, y }), [line, riding, y]);
}

/** Holds the anchor on a line (by default the line the edge is on now). */
export function hold(anchor: EdgeAnchor, at: number) {
  anchor.line.jump(at);
  anchor.riding.set(0);
}

/** Holds the anchor where it is drawn now: on the edge's line if it was riding, else where it was
 *  already held (a change that interrupts another must not make it jump). */
export function holdInPlace(anchor: EdgeAnchor, edge: number) {
  if (anchor.riding.get()) hold(anchor, edge);
}

/** A motion value's animation as a promise that resolves when it settles. */
export function run(value: MotionValue<number>, to: number, transition: ValueAnimationTransition<number>) {
  return new Promise<void>((resolve) => {
    animate(value, to, { ...transition, onComplete: () => resolve() });
  });
}

/**
 * The board's two morphs, the tip view (components/today/tips/TipView.tsx) and the explainer
 * player (components/today/ExplainerPlayer.tsx), on one timeline (2026-10-03). Closing is opening
 * run backwards on the same spring, so the two read as one gesture, and it ends in the gentle
 * spring's own soft landing (bounce 0.08: one slight settle, no wobble). Times are seconds from the
 * tap; the frame looks done at 0.55 s.
 *
 *   open                                       close
 *   0      frame starts growing (gentle)       0      frame starts shrinking (gentle), opaque
 *   0      tile's face fades out    → 0.12    0      view's content fades out      → 0.15
 *   0      pin's ivory turns dark   → 0.20    0.15   tiles fade back in underneath → 0.55
 *   0      tiles fade out underneath → 0.55   0.35   dark turns back to the pin's ivory → 0.55
 *   0.15   view's content fades in  → 0.40    0.40   tile's face fades back in     → 0.55
 *   0.55   frame lands                        0.55   frame lands in the tile; once the spring has
 *                                                     settled (~0.9 s) the tile takes over unseen
 *
 * The frame itself never fades: it is opaque from the first frame to the last, so the surface is
 * continuous. The card's height rides the same gentle spring (AutoHeight), so it follows the frame.
 */
export const BOARD_MORPH = {
  /** The frame's box, both ways, and the board's height under it. */
  frame: MORPH.frame,
  /** The other tiles leaving: the frame's own visual duration, without its overshoot. */
  tilesOut: { type: "spring", visualDuration: SPRINGS.gentle.visualDuration, bounce: 0 },
  /** The other tiles coming back over the last part of the shrink, done as the frame lands. */
  tilesIn: { type: "spring", visualDuration: 0.4, bounce: 0, delay: 0.15 },
  /** The full view's content: in once the box has started growing, out before it shrinks far. */
  contentIn: MORPH.contentIn,
  contentOut: MORPH.contentOut,
  /** The small tile's own face (or the pin's), carried inside the frame at its own size. */
  faceOut: { duration: 0.12, ease: EASE_OUT },
  faceIn: { duration: 0.15, ease: EASE_OUT, delay: 0.4 },
  /** The pin's ivory over the explainer's dark frame. */
  surfaceOut: { duration: 0.2, ease: EASE_OUT },
  surfaceIn: { duration: 0.2, ease: EASE_OUT, delay: 0.35 },
} as const;

/** The tiles under an open view, and back. */
export const TILES_COVERED = { opacity: 0, filter: "blur(4px)" } as const;
export const TILES_SHOWN = { opacity: 1, filter: "blur(0px)" } as const;

/** If the frame's shrink never reports its end (nothing to travel), the tile takes over after this. */
export const MORPH_SETTLE_MS = 1000;

/** The morph timeline, or every step instant under reduced motion. */
export function boardMorph(reduce: boolean): { [K in keyof typeof BOARD_MORPH]: (typeof BOARD_MORPH)[K] | typeof INSTANT } {
  if (!reduce) return BOARD_MORPH;
  return Object.fromEntries(Object.keys(BOARD_MORPH).map((key) => [key, INSTANT])) as never;
}

export type Box = { top: number; left: number; width: number; height: number };

/**
 * Where `el` sits inside `ancestor` (a positioned box), from layout offsets, so a transform or a
 * fade running on anything in between does not skew it. This is the box a closing frame lands in.
 */
export function boxWithin(el: HTMLElement, ancestor: HTMLElement): Box {
  let top = 0;
  let left = 0;
  let node: HTMLElement | null = el;
  while (node && node !== ancestor) {
    top += node.offsetTop;
    left += node.offsetLeft;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== ancestor) {
    const a = ancestor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    top = r.top - a.top;
    left = r.left - a.left;
  }
  return { top, left, width: el.offsetWidth, height: el.offsetHeight };
}

/** Clears a `visibility: hidden` Motion left on the far end of a shared box (a tile or pin that a
 *  view stood in for), once the view has handed back to it. */
export function unhide(el: HTMLElement) {
  if (el.style.visibility === "hidden") el.style.visibility = "";
}
