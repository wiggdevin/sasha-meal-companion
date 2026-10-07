"use client";

import { useEffect, type ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotionConfig, useTransform, type MotionValue } from "motion/react";
import type { TipDemoKey } from "@/lib/today/board";
import { HoldDragScene, SwipeScene, WaterScene } from "@/components/today/tips/TipDemoCards";
import { Finger, useTrack, type SceneProps } from "@/components/today/tips/TipDemoParts";
import styles from "@/components/today/tips/TipDemo.module.css";

/**
 * The small demonstration in a tip's full view (2026-10-03): the gesture played by a fingertip on a
 * sketch of the control, drawn in the app's own shapes (an olive lens, a charcoal meal card, the
 * orb, the water tile). One clock `t` runs 0 → 1 across a loop of the explainer storyboard's scene
 * length, and every part of a scene is a `useTransform` of it, as the explainer's scenes are
 * (components/today/ExplainerPlayer.tsx). Each loop ends where it began, so it never jumps.
 *
 * Reduced motion: the clock stops on the one frame that shows the gesture best and nothing moves.
 */

/** One loop, the same length as one explainer storyboard scene. */
export const DEMO_SECONDS = 5;
/** The loop starts once the view has mostly grown out of its tile. */
const DEMO_DELAY = 0.3;

/** The frame each demo rests on under reduced motion. */
export const STILL: Record<TipDemoKey, number> = {
  orb: 0.6, scrub: 0.3, month: 0.6, "hold-drag": 0.6, swipe: 0.36, water: 0.55,
};

/* ---- Tap the eye: the card opens around the orb and the entities fly out onto the ring ---- */

const RING = { x: 120, y: 60, r: 40 };
const EYE = { x: 196, y: 24 };
const ENTITIES = ["calories", "protein", "carbs", "fat", "water", "activity", "recovery"].map((kind, i) => {
  const a = (i * 2 * Math.PI) / 7;
  return { kind, ring: { x: RING.x + RING.r * Math.sin(a), y: RING.y - RING.r * Math.cos(a) } };
});

function Entity({ t, kind, ring, index }: SceneProps & (typeof ENTITIES)[number] & { index: number }) {
  // Every entity leaves the orb a beat after it appears, and gathers back into it before it goes.
  const at = [0.34 + index * 0.02, 0.54 + index * 0.02, 0.8, 0.9];
  const x = useTrack(t, at, [RING.x, ring.x, ring.x, RING.x]);
  const y = useTrack(t, at, [RING.y, ring.y, ring.y, RING.y]);
  const opacity = useTrack(t, at, [0, 1, 1, 0]);
  return <motion.circle r={8} cx={x} cy={y} className={styles.entity} data-kind={kind} style={{ opacity }} />;
}

/** The calendar face, sketched: the face switch's eye at the top, the ledger's tab at the foot. */
function CalendarSketch({ opacity }: { opacity: MotionValue<number> }) {
  return <motion.g style={{ opacity }}>
    <rect x="18" y="80" width="204" height="22" rx="11" className={styles.ledgerTab} />
    <rect x="30" y="87" width="40" height="8" rx="3" className={styles.ledgerFigure} />
  </motion.g>;
}

function OrbScene({ t }: SceneProps) {
  const ledger = useTrack(t, [0.22, 0.3, 0.9, 0.98], [1, 0, 0, 1]);
  const orbScale = useTrack(t, [0.26, 0.42, 0.84, 0.94], [0.4, 1, 1, 0.4]);
  const orbOpacity = useTrack(t, [0.26, 0.34, 0.86, 0.94], [0, 1, 1, 0]);
  const track = useTrack(t, [0.3, 0.46, 0.8, 0.9], [0, 1, 1, 0]);
  const show = useTrack(t, [0, 0.04, 0.2, 0.26], [0, 1, 1, 0]);
  const fingerY = useTrack(t, [0, 0.06, 0.2, 0.26], [150, EYE.y + 4, EYE.y + 4, 150]);
  const press = useTrack(t, [0.1, 0.24], [0, 1]);
  return <>
    <rect x="10" y="8" width="220" height="102" rx="16" className={styles.card} />
    <CalendarSketch opacity={ledger} />
    <rect x={EYE.x - 14} y={EYE.y - 9} width="28" height="18" rx="9" className={styles.lens} />
    <motion.circle cx={RING.x} cy={RING.y} r={RING.r} className={styles.track} style={{ opacity: track }} />
    {ENTITIES.map((entity, index) => <Entity key={entity.kind} t={t} index={index} {...entity} />)}
    <motion.g style={{ x: RING.x, y: RING.y, scale: orbScale, opacity: orbOpacity }}>
      <circle cx={0} cy={0} r={15} className={styles.orb} />
    </motion.g>
    <Finger x={EYE.x + 4} y={fingerY} show={show} presses={[press]} />
  </>;
}

/* ---- Slide the week: the days slide under a fixed olive lens; a flick moves a week ---- */

const LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_GAP = 30;
const LENS_X = 120;

function Days({ x, lensed }: { x: MotionValue<number>; lensed?: boolean }) {
  return <motion.g style={{ x }} className={lensed ? styles.daysOnLens : styles.days}>
    {Array.from({ length: 18 }, (_, i) => {
      const cx = LENS_X + (i - 3) * DAY_GAP;
      return <g key={i}>
        <text x={cx} y={60} textAnchor="middle" className={styles.letter}>{LETTERS[i % 7]}</text>
        <circle cx={cx} cy={74} r={2.5} className={i === 3 ? styles.today : styles.dayDot} />
      </g>;
    })}
  </motion.g>;
}

function ScrubScene({ t }: SceneProps) {
  const x = useTrack(t, [0.1, 0.32, 0.5, 0.58, 0.74, 0.94], [0, -DAY_GAP, -DAY_GAP, -8 * DAY_GAP, -8 * DAY_GAP, 0]);
  const fingerX = useTrack(t, [0.1, 0.32, 0.44, 0.5, 0.58], [150, 120, 170, 170, 80]);
  const show = useTrack(t, [0.04, 0.08, 0.34, 0.38, 0.44, 0.48, 0.56, 0.6], [0, 1, 1, 0, 0, 1, 1, 0]);
  return <>
    <defs><clipPath id="tip-demo-lens"><rect x={LENS_X - 14} y="38" width="28" height="48" rx="14" /></clipPath></defs>
    <rect x="10" y="30" width="220" height="64" rx="16" className={styles.card} />
    <rect x={LENS_X - 14} y="38" width="28" height="48" rx="14" className={styles.lens} />
    <Days x={x} />
    <g clipPath="url(#tip-demo-lens)"><Days x={x} lensed /></g>
    <Finger x={fingerX} y={80} show={show} />
  </>;
}

/* ---- Double-tap the week: four more weeks grow out under it ---- */

function MonthScene({ t }: SceneProps) {
  const open = useTrack(t, [0.3, 0.52, 0.82, 0.96], [0, 1, 1, 0]);
  const height = useTransform(open, [0, 1], [0, 84]);
  const rise = useTransform(open, [0, 1], [-10, 0]);
  const show = useTrack(t, [0.02, 0.06, 0.26, 0.3], [0, 1, 1, 0]);
  const fingerY = useTrack(t, [0.02, 0.06, 0.26, 0.3], [80, 40, 40, 80]);
  const first = useTrack(t, [0.08, 0.16], [0, 1]);
  const second = useTrack(t, [0.17, 0.25], [0, 1]);
  const cell = (row: number, col: number) => ({ x: 34 + col * 29, y: 72 + row * 20 });
  return <>
    <defs><clipPath id="tip-demo-month"><motion.rect x="10" y="58" width="220" height={height} /></clipPath></defs>
    <rect x="10" y="8" width="220" height="134" rx="16" className={styles.card} />
    {LETTERS.map((letter, col) => <g key={col}>
      {col === 3 && <rect x={34 + col * 29 - 12} y="16" width="24" height="36" rx="12" className={styles.lens} />}
      <text x={34 + col * 29} y={39} textAnchor="middle" className={col === 3 ? styles.letterOnLens : styles.letter}>{letter}</text>
    </g>)}
    <g clipPath="url(#tip-demo-month)">
      <motion.g style={{ y: rise, opacity: open }}>
        {Array.from({ length: 28 }, (_, i) => {
          const { x, y } = cell(Math.floor(i / 7), i % 7);
          return <rect key={i} x={x - 10} y={y - 7} width="20" height="14" rx="7" className={styles.monthCell} />;
        })}
      </motion.g>
    </g>
    <Finger x={130} y={fingerY} show={show} presses={[first, second]} />
  </>;
}

const SCENES: Record<TipDemoKey, (props: SceneProps) => ReactNode> = {
  orb: OrbScene, scrub: ScrubScene, month: MonthScene,
  "hold-drag": HoldDragScene, swipe: SwipeScene, water: WaterScene,
};

export default function TipDemo({ kind }: { kind: TipDemoKey }) {
  const reduce = useReducedMotionConfig() ?? false;
  const t = useMotionValue(reduce ? STILL[kind] : 0);
  useEffect(() => {
    if (reduce) { t.jump(STILL[kind]); return; }
    t.jump(0);
    const controls = animate(t, 1, { duration: DEMO_SECONDS, ease: "linear", delay: DEMO_DELAY, repeat: Infinity });
    return () => controls.stop();
  }, [reduce, kind, t]);
  const Scene = SCENES[kind];
  return <svg className={styles.demo} viewBox="0 0 240 150" preserveAspectRatio="xMidYMid meet" aria-hidden="true"
    focusable="false" data-demo={kind} data-still={reduce || undefined}>
    <Scene t={t} />
  </svg>;
}
