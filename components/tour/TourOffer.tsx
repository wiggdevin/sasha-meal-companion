"use client";

import { APP_NAME } from "@/lib/brand";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import { requestTour } from "@/components/tour/tour-events";
import styles from "@/components/tour/TourOffer.module.css";

/** How long the bubble stays after a tap, unless it holds focus. */
export const OFFER_MS = 6000;

/**
 * "How <app> works?" — the bubble a tap on the companion shows beside it (owner, 2026-10-08: keep the
 * hop and the hello, offer the overview instead of opening it). It pops out on the bouncy spring,
 * stays a few seconds (longer while it has focus) and opens the overview out of the companion.
 * `shown` is the tap count; each new tap shows it again.
 */
export default function TourOffer({ shown, origin, floating = false }: {
  shown: number;
  /** The companion the overview grows out of. */
  origin: () => Element | null;
  floating?: boolean;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const [open, setOpen] = useState(false);
  const self = useRef<HTMLButtonElement>(null);
  const [lastShown, setLastShown] = useState(shown);
  if (lastShown !== shown) {
    setLastShown(shown);
    if (shown > 0) setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        if (self.current && self.current === document.activeElement) arm();
        else setOpen(false);
      }, OFFER_MS);
    };
    arm();
    return () => clearTimeout(timer);
  }, [open, shown]);
  const bubble = open && <motion.button key="offer" ref={self} type="button" aria-haspopup="dialog"
      className={`tap matte-reset ${styles.bubble} ${floating ? styles.floating : ""}`}
      style={{ originX: 0, originY: 0.5 }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, x: -8 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.8, transition: FADES.quick }}
      transition={reduce ? INSTANT : SPRINGS.bouncy}
      onClick={() => { setOpen(false); requestTour(origin()); }}>
      {`How ${APP_NAME} works?`}
    </motion.button>;
  // Reduced motion: it simply comes and goes.
  return reduce ? bubble || null : <AnimatePresence>{bubble}</AnimatePresence>;
}
