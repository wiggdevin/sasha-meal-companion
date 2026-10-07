"use client";

import type { ReactNode } from "react";
import { motion, useIsPresent, useReducedMotionConfig } from "motion/react";
import { INSTANT, MORPH } from "@/lib/design/motion";

/**
 * A block that grows in when it mounts and folds away when it leaves, under an `AnimatePresence`
 * (MORPH: the box springs on the frame spring both ways, its content fades in once the box has room
 * and fades out as it starts to fold). Only the outer box changes height, and it carries no padding,
 * so a folded box is truly 0 px tall. While it leaves it is already gone for assistive tech, the
 * keyboard and taps. Reduced motion: it simply arrives and leaves.
 *
 * `className` goes on the clipping box: give it room above (padding-top with a matching negative
 * margin) when something inside casts a shadow upward.
 */
export default function Fold({ children, className = "" }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotionConfig() ?? false;
  const present = useIsPresent();
  return <motion.div data-fold="" inert={!present} aria-hidden={present ? undefined : true}
    className={`overflow-clip ${className}`.trim()}
    initial={reduce ? false : { height: 0 }} animate={{ height: "auto" }}
    exit={{ height: 0, transition: reduce ? INSTANT : MORPH.frame }}
    transition={reduce ? INSTANT : MORPH.frame}>
    <motion.div initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1, transition: reduce ? INSTANT : MORPH.contentIn }}
      exit={{ opacity: 0, transition: reduce ? INSTANT : MORPH.contentOut }}>
      {children}
    </motion.div>
  </motion.div>;
}
