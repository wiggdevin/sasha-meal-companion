"use client";

import { motion, useReducedMotionConfig } from "motion/react";
import { BANDS, RAINBOW, bandPath, type Band } from "@/components/today/scene/scene-geometry";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import styles from "@/components/today/scene/PondScene.module.css";

const BAND_CLASS: Record<Band, string> = {
  kcal: styles.bandKcal, protein: styles.bandProtein, carbs: styles.bandCarbs, fat: styles.bandFat,
};

/**
 * The day's rainbow (owner, 2026-10-07: the rings become a rainbow that fills as the user eats).
 * Outside in: calories, protein, carbs, fat. Each band lights from its left foot toward its right as
 * the day's share of that target is eaten; the unlit rest is a faint track. Never more than one
 * arc: a day past its target is a full band, and the key says by how much. Drawn in the scene's
 * 350 × 420 box.
 */
export default function Rainbow({ shares, bands = BANDS }: { shares: Record<Band, number>; bands?: readonly Band[] }) {
  const reduce = useReducedMotionConfig() ?? false;
  return <svg aria-hidden="true" className={styles.layer} viewBox="0 0 350 420">
    {bands.map((band, i) => {
      const d = bandPath(RAINBOW.radii[i]);
      const share = shares[band];
      return <g key={band} className={BAND_CLASS[band]} data-band={band}>
        <path d={d} className={styles.track} strokeWidth={RAINBOW.band} fill="none" />
        <motion.path d={d} className={styles.band} strokeWidth={RAINBOW.band} fill="none" strokeLinecap="round"
          initial={false} animate={{ pathLength: share > 0 ? share : 0.0001, opacity: share > 0 ? 1 : 0 }}
          transition={reduce ? INSTANT : SPRINGS.smooth} />
      </g>;
    })}
  </svg>;
}
