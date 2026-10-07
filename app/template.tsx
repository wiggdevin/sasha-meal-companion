"use client";

import { useEffect, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { SPRINGS } from "@/lib/design/motion";

/** True once the app has painted its first screen: only later screens arrive with motion, so the
 *  server's HTML is never hidden waiting for script. */
let settled = false;

/**
 * Each screen settles in when a tab opens it (2026-10-01): it rises 12 px into place and fades up on
 * the smooth spring while the dock stays still. Only opacity and a transform that ends at none, so
 * nothing is left behind that would turn a fixed sheet inside the page into an absolute one. The
 * viewed day is a query string written with replaceState, so changing day never replays this.
 */
export default function Template({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  useEffect(() => { settled = true; }, []);
  return <motion.div initial={settled && !reduce ? { opacity: 0, y: 12 } : false} animate={{ opacity: 1, y: 0 }}
    transition={reduce ? { duration: 0 } : { ...SPRINGS.smooth, opacity: { duration: 0.28, ease: [0.16, 1, 0.3, 1] } }}>
    {children}
  </motion.div>;
}
