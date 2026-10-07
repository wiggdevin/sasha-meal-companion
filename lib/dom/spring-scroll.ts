import { animate } from "motion/react";
import { MORPH } from "@/lib/design/motion";

const USER_INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** The floating dock's height plus its gap: anything whose foot is below `innerHeight` minus this is
 *  hidden under the dock. */
export const DOCK_CLEARANCE = 96;

/** Where `scrollIntoView({ block: "start" })` would scroll the page to put `el`'s top: its
 *  scroll-margin and the page's scroll-padding respected. */
export function scrollTargetFor(el: HTMLElement): number {
  const root = document.scrollingElement ?? document.documentElement;
  const offset = (parseFloat(getComputedStyle(el).scrollMarginTop) || 0)
    + (parseFloat(getComputedStyle(root).scrollPaddingTop) || 0);
  return Math.max(0, root.scrollTop + el.getBoundingClientRect().top - offset);
}

/**
 * Scrolls the page to `to` on the morph frame spring (MORPH), so a surface that changes shape and
 * the page that brings it into view move as one gesture. The browser's own smooth scroll ran on a
 * different, faster curve and measured its target while the surface was still changing (owner,
 * 2026-10-04: "the whole app bounces"). Any touch, wheel or key hands the page back to the user at
 * once. Returns a stop function.
 */
export function springScrollTo(to: number, reduce: boolean): () => void {
  const root = document.scrollingElement ?? document.documentElement;
  const from = root.scrollTop;
  if (Math.abs(to - from) < 1) return () => {};
  if (reduce) {
    root.scrollTop = to;
    return () => {};
  }
  const controls = animate(from, to, { ...MORPH.frame, onUpdate: (value) => { root.scrollTop = value; } });
  const stop = () => {
    controls.stop();
    for (const type of USER_INPUT) window.removeEventListener(type, stop);
  };
  for (const type of USER_INPUT) window.addEventListener(type, stop, { passive: true });
  void controls.finished.then(stop, stop);
  return stop;
}

/**
 * Scrolls `el`'s top to where `scrollIntoView({ block: "start" })` would put it, on the morph spring.
 * `finalShrink` is how much shorter the page will be once the morph under way has settled: the target
 * is capped at the furthest the page will then scroll, so the page never travels past it and is pulled
 * back as the content shrinks.
 */
export function springScrollIntoView(el: HTMLElement, reduce: boolean, finalShrink = 0): () => void {
  const root = document.scrollingElement ?? document.documentElement;
  const finalMax = Math.max(0, root.scrollHeight - finalShrink - root.clientHeight);
  return springScrollTo(Math.min(scrollTargetFor(el), finalMax), reduce);
}
