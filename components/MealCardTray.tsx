"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "motion/react";
import AutoHeight from "@/components/ui/AutoHeight";
import { INSTANT, MORPH, SWAP } from "@/lib/design/motion";

/**
 * One face of a meal card's tray: the card's own detail (ingredients and footer) or a flow the card
 * started (Plan with the assistant, Log what you ate, Swap). Faces swap in place (DESIGN.md §Motion, SWAP): the
 * leaving face blurs out first, the tray's height springs to the next face on the card's gentle
 * spring (the AutoHeight around it), and the next face blurs in once the frame has room. Closing a
 * flow runs the same way back. A leaving face is already gone for assistive tech, keys and taps.
 * Reduced motion: faces simply swap.
 */
export function TrayFace({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotionConfig() ?? false;
  const present = useIsPresent();
  return <motion.div inert={!present} aria-hidden={present ? undefined : true} className={className}
    // At rest the face carries no filter: a lingering blur(0px) would keep a compositing layer and
    // make the face a containing block for anything fixed inside it.
    initial={reduce ? false : SWAP.hidden} animate={{ ...SWAP.shown, transitionEnd: { filter: "none" } }}
    exit={{ ...SWAP.hidden, transition: reduce ? INSTANT : MORPH.contentOut }}
    transition={reduce ? INSTANT : MORPH.contentIn}>
    {children}
  </motion.div>;
}

/**
 * The flow inside a card with nothing planned yet (an ivory card, no tray): it grows open under the
 * card's own header on the same spring and folds back into it.
 */
export function EmptyCardFlow({ open, children }: { open: boolean; children: ReactNode }) {
  return <AutoHeight spring="gentle">
    <AnimatePresence mode="wait" initial={false}>{open && children}</AnimatePresence>
  </AutoHeight>;
}
