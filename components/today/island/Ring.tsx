"use client";

import { useId } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import styles from "@/components/today/island/Island.module.css";

/**
 * A ring gauge (owner's reference, 2026-10-05: circular rings with the figure inside), as a jelly tube
 * (2026-10-06): a carved groove, a body lit from the top and deep at the bottom (a gradient mixed from
 * the macro's own colour), a gloss line along it and a specular cap riding its leading end. The arc
 * draws on the bouncy spring, so a change overshoots a hair and settles. The colour is a fill class
 * (`macro-*`, a gauge colour) on the svg: every layer derives from `currentColor`.
 */
export default function Ring({ share, size = 64, stroke = 5, colorClass, onLight = false, children }: {
  share: number; size?: number; stroke?: number; colorClass: string;
  /** On the ivory card (the Overview): the empty track is ink, not light. */
  onLight?: boolean; children?: React.ReactNode;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const gradient = `${useId().replace(/:/g, "")}-jelly`;
  const r = (size - stroke) / 2;
  const c = size / 2;
  const clamped = Math.max(0, Math.min(1, share));
  const shown = clamped > 0;
  const draw = { pathLength: shown ? clamped : 0.001, opacity: shown ? 1 : 0 };
  const transition = reduce ? INSTANT : SPRINGS.bouncy;
  return <span className={styles.ring} style={{ width: size, height: size }}>
    {!onLight && size >= 56 && <span aria-hidden="true" className={`${styles.ringSpill} ${colorClass}`} />}
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true"
      className={`${styles.ringSvg} ${colorClass}`}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2={size} gradientUnits="userSpaceOnUse">
          <stop offset="0" className={styles.stopHi} />
          <stop offset="0.55" className={styles.stopMid} />
          <stop offset="1" className={styles.stopLo} />
        </linearGradient>
      </defs>
      <circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} className={onLight ? styles.ringTrackLight : styles.ringTrack} />
      <motion.circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" stroke={`url(#${gradient})`}
        className={styles.ringArc} transform={`rotate(-90 ${c} ${c})`}
        initial={false} animate={draw} transition={transition} />
      <motion.circle cx={c} cy={c} r={r - stroke * 0.18} fill="none" strokeWidth={Math.max(1, stroke * 0.26)}
        strokeLinecap="round" className={styles.ringGloss} transform={`rotate(-90 ${c} ${c})`}
        initial={false} animate={draw} transition={transition} />
      {/* The specular cap at the arc's leading end; the empty circle sets the group's box to the ring, so it turns about the centre. */}
      <motion.g initial={false} animate={{ rotate: clamped * 360, opacity: shown ? 1 : 0 }} transition={transition}>
        <circle cx={c} cy={c} r={c} fill="none" stroke="none" />
        <circle cx={c} cy={stroke / 2} r={Math.max(1, stroke * 0.24)} className={styles.ringCap} />
      </motion.g>
    </svg>
    <span className={styles.ringCentre}>{children}</span>
  </span>;
}
