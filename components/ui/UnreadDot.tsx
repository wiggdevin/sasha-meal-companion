"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { spring } from "@/lib/design/motion";
import styles from "./UnreadDot.module.css";

/**
 * The unread mark: a dot that grows in on the snappy spring and shrinks away the same way, instant
 * under reduced motion. It is hidden from assistive tech; the control it sits on says "new" in its
 * own name.
 */
export default function UnreadDot({ show, className = "" }: { show: boolean; className?: string }) {
  const reduce = useReducedMotion();
  return <AnimatePresence initial={false}>
    {show && <motion.span key="unread" aria-hidden="true" data-unread-dot="true"
      className={`${styles.dot} ${className}`.trim()}
      initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0, opacity: 0 }} transition={spring("snappy", reduce)} />}
  </AnimatePresence>;
}
