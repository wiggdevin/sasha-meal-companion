"use client";

import { motion, useTransform, type MotionValue } from "motion/react";
import styles from "@/components/today/tips/TipDemo.module.css";

/** The pieces every tip demonstration is built from (components/today/tips/TipDemo.tsx). */

export type SceneProps = { t: MotionValue<number> };

/** A keyframed track over the loop: `at` are moments in 0..1, `to` the values at them. */
export function useTrack(t: MotionValue<number>, at: number[], to: number[]) {
  return useTransform(t, at, to);
}

/** A tap's ring: it grows out from the fingertip and fades as `press` runs 0 → 1. */
function Ripple({ press }: { press: MotionValue<number> }) {
  const scale = useTransform(press, [0, 1], [0.4, 1.5]);
  const opacity = useTransform(press, [0, 0.15, 1], [0, 1, 0]);
  return <motion.circle r={14} className={styles.ripple} style={{ scale, opacity }} />;
}

/**
 * The fingertip: a line-drawn finger reaching up from below, its touch point at (0, 0). `presses`
 * draw a ring per tap; `hold` traces a ring round the touch point while a press matures.
 */
export function Finger({ x, y, show, presses = [], hold, holdShow }: {
  x: MotionValue<number> | number; y: MotionValue<number> | number; show: MotionValue<number>;
  presses?: MotionValue<number>[]; hold?: MotionValue<number>; holdShow?: MotionValue<number>;
}) {
  return <motion.g style={{ x, y, opacity: show }} data-finger="">
    {presses.map((press, i) => <Ripple key={i} press={press} />)}
    {hold && <motion.circle r={17} className={styles.holdRing} transform="rotate(-90)"
      style={{ pathLength: hold, opacity: holdShow }} />}
    <path className={styles.finger} d="M-10 6C-10-3.5-5.6-9 0-9s10 5.5 10 15v40h-20Z" />
    <path className={styles.nail} d="M-5 -1.5C-5-4.5-2.8-6 0-6s5 1.5 5 4.5v3.5h-10Z" />
  </motion.g>;
}
