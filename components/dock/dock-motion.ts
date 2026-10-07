import type { PointerEvent } from "react";
import { LENS_PILL_ID, LENS_ROUND_ID } from "@/components/dock/liquid-lens";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";

/* Geometry (px). The capsule and the assistant bubble share one 64 px height. */
export const BUBBLE = 64;
export const SPLIT = 10;
export const PAD = 6;
export const TAB_GAP = 4;
export const ACTIVE_WEIGHT = 1.8;
/** Height the ask field grows to when its attach tray is out. */
export const TRAY_OPEN = 136;
/** The dock's own lift off the safe-area bottom (TabBar's `nav`); shared with CoachShell so its
 *  page can reserve exactly enough room to clear the dock, tray included. */
export const DOCK_BOTTOM_OFFSET = 12;
export const COACH_HREF = "/coach";

/* Springs: the dock reads the named springs in lib/design/motion.ts (PRD U10), never its own
   stiffness/damping. Each constant keeps its role name and takes the nearest named spring:
   - MORPH (capsule ⇄ bubble, the lens): `bouncy` — the glass keeps a little elastic give.
   - TAB_MOVE and LEAD_EDGE (the lens and the edge it leads with): `snappy`.
   - TRAIL_EDGE: `bouncy`, deliberately slower than LEAD_EDGE, so the lens still stretches as it
     travels and catches up behind its leading edge.
   - PRESS: `snappy`. Deliberate difference: the old press spring (700/18) wobbled visibly; the
     system's control spring keeps a trace of give and no more.
   - GROW (the ask field opening its tray): `snappy`, the same speed the old spring had.
   - FADE: the quick fade (0.15 s, the system's ease-out) in place of the dock's own 0.18 s. */
export const MORPH = SPRINGS.bouncy;
export const TAB_MOVE = SPRINGS.snappy;
export const LEAD_EDGE = SPRINGS.snappy;
export const TRAIL_EDGE = SPRINGS.bouncy;
export const PRESS = SPRINGS.snappy;
export const GROW = SPRINGS.snappy;
export const FADE = FADES.quick;
export { INSTANT };

/** Which lens a glass body refracts through: its resting shape decides. */
export const lensVar = (shape: "pill" | "round") =>
  ({ "--lens": `url(#${shape === "pill" ? LENS_PILL_ID : LENS_ROUND_ID})` }) as React.CSSProperties;

/** Glass catches the light where a finger or pointer is. Written straight to CSS vars, no render. */
export function sheen(event: PointerEvent<HTMLElement>) {
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--lx", `${event.clientX - box.left}px`);
  event.currentTarget.style.setProperty("--ly", `${event.clientY - box.top}px`);
  event.currentTarget.style.setProperty("--lo", "1");
}
export function sheenOff(event: PointerEvent<HTMLElement>) {
  event.currentTarget.style.setProperty("--lo", "0");
}

/** Rubber-band a drag distance: follows closely at first, then resists (Apple scroll feel). */
export function rubber(distance: number, limit: number): number {
  const sign = Math.sign(distance);
  return sign * limit * (1 - Math.exp(-Math.abs(distance) / limit));
}
