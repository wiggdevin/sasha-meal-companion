"use client";

import { useId, type ReactNode } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import type { MacroKey } from "@/components/nutrition/spec";
import styles from "./LiquidRings.module.css";

export type RingDatum = { key: MacroKey; share: number };

/** Stroke, gap and the centre radius of each ring, outermost first, for a square of `size`. */
export function ringGeometry(size: number, count: number) {
  const stroke = Math.max(2, Math.round(size * 0.05));
  const gap = Math.max(1, Math.round(stroke * 0.42));
  const outer = size / 2 - stroke / 2 - Math.max(1, size * 0.012);
  return { stroke, gap, radii: Array.from({ length: count }, (_, at) => outer - at * (stroke + gap)) };
}

/** The arc's colour runs from its deep start to its hot head (Kimi K3): a line from the start to the
 *  head, or to the opposite side once the arc has passed three quarters. In the arc's own space,
 *  turned a quarter back, so its start is at 3 o'clock there and at 12 on the screen. */
function flowLine(c: number, r: number, filled: number) {
  const turn = Math.min(Math.max(filled, 0.08), 0.75) * 2 * Math.PI;
  return { x1: c + r, y1: c, x2: c + r * Math.cos(turn), y2: c + r * Math.sin(turn) };
}

/**
 * The day's macros as liquid rings (owner, 2026-10-06: "more vibrant and morphing"; repurposed from
 * the owner's goo loader). Each ring is a vivid gradient arc on a faint groove; under one goo filter
 * (blur, then an alpha threshold, then the original colour laid back on top) three droplets ride
 * the filled arc and a head bead breathes at its leading end, so the arc swells and merges like
 * liquid without ever reaching past what was eaten. A blurred twin under each arc is its glow.
 * Reduced motion: the arcs only, drawn at once. `mini` is the collapsed bar's static glyph.
 */
export default function LiquidRings({ rings, size, focus, mini = false, children }: {
  rings: readonly RingDatum[];
  size: number;
  /** The macro the readout names: a chosen gram macro dims the others a little; calories dims none. */
  focus?: MacroKey;
  mini?: boolean;
  children?: ReactNode;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const id = useId().replace(/:/g, "");
  const { stroke, radii } = ringGeometry(size, rings.length);
  const c = size / 2;
  const live = !reduce && !mini;
  const draw = reduce || mini ? INSTANT : SPRINGS.bouncy;
  return <span className={styles.rings} data-mini={mini || undefined} style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className={styles.ringsSvg}>
      {!mini && <defs>
        <filter id={`${id}-glow`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation={stroke * 0.4} />
        </filter>
        <linearGradient id={`${id}-gloss-fade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="white" />
          <stop offset="0.45" stopColor="white" stopOpacity="0.5" />
          <stop offset="0.7" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-gloss`} maskUnits="userSpaceOnUse" x="0" y="0" width={size} height={size}>
          <rect width={size} height={size} fill={`url(#${id}-gloss-fade)`} />
        </mask>
        {live && <filter id={`${id}-goo`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceGraphic" stdDeviation={stroke * 0.3} result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo" />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>}
      </defs>}
      {rings.map(({ key, share }, at) => {
        const r = radii[at];
        const filled = Math.max(0, Math.min(1, share));
        const shown = filled > 0.005;
        const arc = { pathLength: shown ? filled : 0.001, opacity: shown ? 1 : 0 };
        const paint = `url(#${id}-${key})`;
        const turn = `rotate(-90 ${c} ${c})`;
        return <g key={key} className={styles.ring} data-macro={key}
          data-dim={focus !== undefined && focus !== "kcal" && focus !== key ? "" : undefined}>
          <defs>
            <linearGradient id={`${id}-${key}`} gradientUnits="userSpaceOnUse" {...flowLine(c, r, filled)}>
              <stop offset="0" className={styles.stopA} />
              <stop offset="1" className={styles.stopB} />
            </linearGradient>
            {live && <mask id={`${id}-${key}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width={size} height={size}>
              <motion.circle cx={c} cy={c} r={r} fill="none" stroke="white" strokeWidth={stroke * 2}
                transform={turn} initial={false} animate={arc} transition={draw} />
            </mask>}
          </defs>
          <circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} className={styles.groove} />
          <g className={styles.arcs}>
          {!mini && <motion.circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
            stroke={paint} className={styles.glow} filter={`url(#${id}-glow)`} transform={turn} initial={false} animate={arc} transition={draw} />}
          <g filter={live ? `url(#${id}-goo)` : undefined}>
            <motion.circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" stroke={paint}
              transform={turn} initial={false} animate={arc} transition={draw} />
            {live && shown && <g mask={`url(#${id}-${key}-mask)`}>
              <circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke * 1.35} strokeLinecap="round" stroke={paint}
                pathLength={100} strokeDasharray="0.1 33.23" transform={turn} className={styles.droplets}
                style={{ animationDuration: `${9 + at * 2.6}s` }} />
            </g>}
            {live && shown && <motion.g initial={false} animate={{ rotate: filled * 360 }} transition={draw}
              style={{ originX: "50%", originY: "50%" }}>
              <circle cx={c} cy={c} r={c} fill="none" stroke="none" />
              <circle cx={c} cy={c - r} r={stroke * 0.62} className={styles.head}
                style={{ animationDelay: `${at * -0.7}s` }} />
            </motion.g>}
          </g>
          {!mini && shown && <g mask={`url(#${id}-gloss)`}>
            <motion.circle cx={c} cy={c} r={r + stroke * 0.2} fill="none" strokeWidth={Math.max(1, stroke * 0.16)}
              strokeLinecap="round" className={styles.gloss} transform={turn} initial={false} animate={arc} transition={draw} />
          </g>}
          {!mini && shown && <motion.g initial={false} animate={{ rotate: filled * 360 }} transition={draw}
            style={{ originX: "50%", originY: "50%" }}>
            <circle cx={c} cy={c} r={c} fill="none" stroke="none" />
            <circle cx={c} cy={c - r - stroke * 0.18} r={Math.max(1, stroke * 0.17)} className={styles.spark} />
          </motion.g>}
          </g>
        </g>;
      })}
    </svg>
    {children && <span className={styles.ringsCentre}>{children}</span>}
  </span>;
}
