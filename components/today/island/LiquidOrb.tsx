"use client";

import { motion, useReducedMotionConfig } from "motion/react";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import styles from "@/components/today/island/Island.module.css";

/**
 * The island's living orb (owner, 2026-10-05: "alive, like it's living, breathing"; the reference
 * clip's character orb). A glass bead holding liquid up to the share of the day's calories eaten: the
 * level rises on the bouncy spring, the surface sways as a slow wave, the bead breathes and its
 * highlight drifts. The tint follows the day — sage under, amber near, rose over — or is water blue. Reduced motion
 * holds it still. Decorative: the island's text says the same thing in words.
 */
export default function LiquidOrb({ share, mood, size = 36 }: {
  share: number; mood: "under" | "near" | "over" | "water"; size?: number;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const level = Math.max(0.06, Math.min(1, share));
  return <span aria-hidden="true" className={styles.orb} data-mood={mood} data-still={reduce || undefined}
    style={{ width: size, height: size }}>
    <motion.span className={styles.liquid} initial={false} animate={{ y: `${(1 - level) * 100}%` }}
      transition={reduce ? INSTANT : SPRINGS.bouncy}>
      <span className={styles.wave} />
    </motion.span>
    <span className={styles.orbGlint} />
  </span>;
}
