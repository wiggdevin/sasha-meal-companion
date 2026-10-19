"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { animate, useMotionValue, type AnimationPlaybackControls } from "motion/react";
import { SPRINGS } from "@/lib/design/motion";

/**
 * The Day card's faces box (components/today/DayCard.tsx): its live height as a motion value.
 * Between face changes the box takes its content's height (the month grows, a row opens in place)
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
