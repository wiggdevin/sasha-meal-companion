/**
 * Liquid motion (DESIGN.md §Motion, 2026-10-01). Every morph in the app rides one of four springs,
 * so a card that grows, a lens that slides and a sheet that rises share one physics. Springs are
 * given by how long they look (`visualDuration`) and how much they overshoot (`bounce`), the way
 * SwiftUI's `.smooth`, `.snappy` and `.bouncy` are; the CSS twins live in app/globals.css as
 * `--ease-spring-*` with their `--dur-spring-*`.
 *
 * Reduced motion: every helper here returns an instant transition, so an element simply arrives.
 */
export const SPRINGS = {
  /** Containers that grow or shrink (cards, faces, trays, sheets): no overshoot. */
  smooth: { type: "spring", visualDuration: 0.45, bounce: 0 },
  /** Controls (lenses, segments, chips, presses): quick, a trace of give. */
  snappy: { type: "spring", visualDuration: 0.3, bounce: 0.15 },
  /** Things with weight (the orb, entities leaving the orb): visible life. */
  bouncy: { type: "spring", visualDuration: 0.5, bounce: 0.28 },
  /** Large shape changes (a meal card opening, a video pin filling its face). */
  gentle: { type: "spring", visualDuration: 0.55, bounce: 0.08 },
} as const;

export type SpringName = keyof typeof SPRINGS;

/** Strong ease-out: content arriving decelerates into place and never eases in. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const FADES = {
  /** Something leaving, or a label swapping. */
  quick: { duration: 0.15, ease: EASE_OUT },
  /** Content arriving. */
  base: { duration: 0.25, ease: EASE_OUT },
} as const;

export const INSTANT = { duration: 0 } as const;

/**
 * The one morph rule for a surface that changes shape (2026-10-04, from the Day card's board): the
 * frame rides the gentle spring both ways, so closing is opening run backwards and ends in its soft
 * landing; the frame itself never fades; its content fades in once the frame has room and fades out
 * as it starts to shrink. The board (components/today/useDayCardMotion.ts, BOARD_MORPH), the meal
 * card's tray and footer, and the panels joined to a meal card all read these.
 */
export const MORPH = {
  /** The frame's box, both ways, and anything whose height follows it. */
  frame: SPRINGS.gentle,
  /** Content arriving: once the box has started growing. */
  contentIn: { duration: 0.25, ease: EASE_OUT, delay: 0.15 },
  /** Content leaving: before the box has shrunk far. */
  contentOut: { duration: 0.15, ease: EASE_OUT },
} as const;

/** The named spring, or an instant arrival under reduced motion. */
export function spring(name: SpringName, reduce: boolean | null | undefined) {
  return reduce ? INSTANT : SPRINGS[name];
}

/** The named fade, or an instant arrival under reduced motion. */
export function fade(name: keyof typeof FADES, reduce: boolean | null | undefined) {
  return reduce ? INSTANT : FADES[name];
}

/** How content leaves and arrives when one view gives way to another in the same place: a short
 *  blur so the swap reads as one surface changing focus, never as a cut. */
export const SWAP = {
  hidden: { opacity: 0, filter: "blur(6px)", scale: 0.98 },
  shown: { opacity: 1, filter: "blur(0px)", scale: 1 },
} as const;
