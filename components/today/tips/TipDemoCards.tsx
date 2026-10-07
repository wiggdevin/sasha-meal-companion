"use client";

import { motion, useTransform } from "motion/react";
import { Finger, useTrack, type SceneProps } from "@/components/today/tips/TipDemoParts";
import styles from "@/components/today/tips/TipDemo.module.css";

/**
 * The demonstrations that play on a meal card or the water tile (components/today/tips/TipDemo.tsx
 * holds the clock, the fingertip and the calendar ones). Times are moments in the 0..1 loop.
 */

/** A compact charcoal meal card: the olive art thumbnail and two cream lines for its title. */
function MealCard({ x, y, width }: { x: number; y: number; width: number }) {
  return <>
    <rect x={x} y={y} width={width} height="44" rx="12" className={styles.meal} />
    <rect x={x + 6} y={y + 6} width="32" height="32" rx="8" className={styles.mealArt} />
    <rect x={x + 46} y={y + 10} width={Math.min(76, width - 60)} height="6" rx="3" className={styles.mealLine} />
    <rect x={x + 46} y={y + 22} width={Math.min(44, width - 60)} height="5" rx="2.5" className={styles.mealLineFaint} />
  </>;
}

/* ---- Hold a meal card: it lifts, then follows the finger to a later time ---- */

const HOUR = 48;

export function HoldDragScene({ t }: SceneProps) {
  const lift = useTrack(t, [0.28, 0.34, 0.66, 0.72], [0, 1, 1, 0]);
  const scale = useTransform(lift, [0, 1], [1, 1.04]);
  const y = useTrack(t, [0.36, 0.64, 0.84, 0.98], [0, HOUR, HOUR, 0]);
  const before = useTrack(t, [0.44, 0.52, 0.86, 0.94], [1, 0, 0, 1]);
  const after = useTrack(t, [0.44, 0.52, 0.86, 0.94], [0, 1, 1, 0]);
  const show = useTrack(t, [0, 0.06, 0.72, 0.8], [0, 1, 1, 0]);
  const fingerY = useTrack(t, [0, 0.08, 0.36, 0.64, 0.72, 0.82], [120, 46, 46, 46 + HOUR, 46 + HOUR, 140]);
  const hold = useTrack(t, [0.1, 0.3], [0, 1]);
  const holdShow = useTrack(t, [0.08, 0.1, 0.32, 0.36], [0, 1, 1, 0]);
  return <>
    {["12 PM", "1 PM", "2 PM"].map((label, i) => <g key={label}>
      <text x={18} y={48 + i * HOUR} className={styles.label}>{label}</text>
      <line x1={58} x2={226} y1={44 + i * HOUR} y2={44 + i * HOUR} className={styles.hairline} />
    </g>)}
    <motion.g style={{ y }}>
      <motion.rect x={66} y={26} width={154} height={44} rx={12} className={styles.lifted} style={{ opacity: lift }} />
      <motion.g style={{ scale }}>
        <MealCard x={66} y={22} width={154} />
        <motion.text x={112} y={58} className={styles.mealTime} style={{ opacity: before }}>12:30 PM</motion.text>
        <motion.text x={112} y={58} className={styles.mealTime} style={{ opacity: after }}>1:30 PM</motion.text>
      </motion.g>
    </motion.g>
    <Finger x={186} y={fingerY} show={show} hold={hold} holdShow={holdShow} />
  </>;
}

/* ---- Swipe a meal left: Clear shows first and the card stops; farther, Delete ---- */

export function SwipeScene({ t }: SceneProps) {
  const x = useTrack(t, [0.08, 0.3, 0.42, 0.58, 0.66, 0.84], [0, -80, -80, -150, -150, 0]);
  const clear = useTransform(x, [0, -80], [0, 1]);
  const remove = useTransform(x, [-80, -150], [0, 1]);
  const show = useTrack(t, [0, 0.06, 0.84, 0.9], [0, 1, 1, 0]);
  const fingerX = useTransform(x, (v) => 196 + v);
  const fingerY = useTrack(t, [0, 0.06, 0.84, 0.9], [130, 80, 80, 130]);
  return <>
    <rect x="12" y="52" width="216" height="52" rx="16" className={styles.tray} />
    <motion.g style={{ opacity: remove }}>
      <rect x="84" y="61" width="64" height="34" rx="17" className={styles.delete} />
      <text x="116" y="82" textAnchor="middle" className={styles.actionLabel}>Delete</text>
    </motion.g>
    <motion.g style={{ opacity: clear }}>
      <rect x="156" y="61" width="64" height="34" rx="17" className={styles.clear} />
      <text x="188" y="82" textAnchor="middle" className={styles.actionLabel}>Clear</text>
    </motion.g>
    <motion.g style={{ x }}>
      <MealCard x={12} y={56} width={216} />
    </motion.g>
    <Finger x={fingerX} y={fingerY} show={show} />
  </>;
}

/* ---- Add water fast: a tap adds a step; hold and slide opens the bar and sets the total ---- */

const TILE = { x: 70, y: 50, w: 100, h: 92 };
const BAR = { x: 40, w: 160 };

export function WaterScene({ t }: SceneProps) {
  const level = useTrack(t, [0.12, 0.2, 0.66, 0.78, 0.86, 0.98], [0.3, 0.42, 0.42, 0.85, 0.85, 0.3]);
  const liquidY = useTransform(level, (v) => TILE.y + TILE.h * (1 - v));
  const bar = useTrack(t, [0.38, 0.42, 0.66, 0.7], [0, 1, 1, 0]);
  const pending = useTrack(t, [0.42, 0.62], [0, 0.43]);
  const added = useTransform(pending, (v) => Math.max(0.001, v * BAR.w));
  const show = useTrack(t, [0, 0.06, 0.7, 0.78], [0, 1, 1, 0]);
  const fingerX = useTrack(t, [0.42, 0.62], [120, 170]);
  const fingerY = useTrack(t, [0, 0.06, 0.7, 0.78], [150, 100, 100, 150]);
  const tap = useTrack(t, [0.1, 0.24], [0, 1]);
  const hold = useTrack(t, [0.28, 0.38], [0, 1]);
  const holdShow = useTrack(t, [0.26, 0.28, 0.4, 0.44], [0, 1, 1, 0]);
  return <>
    <defs><clipPath id="tip-demo-tile"><rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} rx="16" /></clipPath></defs>
    <rect x={TILE.x} y={TILE.y} width={TILE.w} height={TILE.h} rx="16" className={styles.waterTile} />
    <g clipPath="url(#tip-demo-tile)">
      <motion.rect x={TILE.x} y={liquidY} width={TILE.w} height={TILE.h} className={styles.liquid} />
    </g>
    <text x={TILE.x + 12} y={TILE.y + 22} className={styles.label}>Water</text>
    <rect x={TILE.x + 12} y={TILE.y + TILE.h - 26} width="36" height="16" rx="8" className={styles.addPill} />
    <motion.g style={{ opacity: bar }}>
      <rect x={BAR.x - 10} y="8" width={BAR.w + 20} height="28" rx="14" className={styles.bar} />
      <rect x={BAR.x} y="19" width={BAR.w} height="6" rx="3" className={styles.barTrack} />
      <rect x={BAR.x} y="19" width={BAR.w * 0.42} height="6" rx="3" className={styles.barBase} />
      <motion.rect x={BAR.x + BAR.w * 0.42} y={19} width={added} height={6} rx={3} className={styles.barAdd} />
    </motion.g>
    <Finger x={fingerX} y={fingerY} show={show} presses={[tap]} hold={hold} holdShow={holdShow} />
  </>;
}
