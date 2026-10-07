"use client";

import { useId, type CSSProperties } from "react";
import type { OrbitKey } from "@/lib/today/health-orbit";
import styles from "@/components/HealthOrbit.module.css";

/* The orbit's seven living entities (2026-09-30; food forms 2026-10-01): one borderless
   inline SVG each, drawn in currentColor with a lit volume gradient and a white highlight. The
   nutrients are food — an apple (calories), wheat (carbs), a fried egg (protein), an avocado (fat),
   a water drop — beside the flame (active burn) and the moon (recovery). CSS in
   HealthOrbit.module.css moves them, gives them a soft contact shadow and holds them still under
   reduced motion. The five nutrient entities keep their fixed gauge
   colours (DESIGN.md §Colors); activity takes the blue data accent and recovery the steel. */
export const MARK_COLOR: Record<OrbitKey, string> = {
  calories: "var(--color-gauge-calories)",
  carbs: "var(--color-gauge-carbs)",
  protein: "var(--color-gauge-protein)",
  fat: "var(--color-gauge-fat)",
  water: "var(--color-gauge-water)",
  activity: "var(--color-tertiary)",
  recovery: "var(--color-plum)",
};

/** The same hues as text-colour utilities, so a mark's `currentColor` comes from a class. */
const MARK_TEXT: Record<OrbitKey, string> = {
  calories: "text-gauge-calories",
  carbs: "text-gauge-carbs",
  protein: "text-gauge-protein",
  fat: "text-gauge-fat",
  water: "text-gauge-water",
  activity: "text-tertiary",
  recovery: "text-plum",
};

/** Gradient ids for one mark: `vol` lights a body from the upper left, `rise` fades a shape out
 *  towards its top. The thin white rim highlights take the `sheen` class instead. */
type Paint = { vol: string; rise: string };
const url = (id: string) => `url(#${id})`;

const STROKE = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;
const SHEEN = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round", className: styles.sheen } as const;
const lag = (seconds: number) => ({ animationDelay: `${-seconds}s` }) as CSSProperties;

/** Calories: an apple, lit from the upper left, its leaf stirring on the stem. */
function Apple({ paint }: { paint: Paint }) {
  return <>
    <path d="M24 15c-3-2.6-9.5-3-12.5 1.5-3.6 5.4-1.6 14 2.4 19.2 2.6 3.4 5.4 5 7.6 4 1.5-.7 3.5-.7 5 0 2.2 1 5-.6 7.6-4 4-5.2 6-13.8 2.4-19.2C33.5 12 27 12.4 24 15z"
      fill={url(paint.vol)} />
    <path d="M24 15c0-3 .8-5.5 2.6-7.5" {...STROKE} strokeWidth="1.8" />
    <path className={styles.leaf} d="M26.4 10.6c2.2-3.6 6-4.6 9-3.6-1.2 3.4-4.8 5.3-9 3.6z" fill="currentColor" fillOpacity="0.7" />
    <path d="M14.6 21c.8-2.4 2.4-3.8 4.4-4.4" {...SHEEN} strokeWidth="1.3" />
    <ellipse className={styles.hot} cx="16.4" cy="25" rx="1.3" ry="2.6" fillOpacity="0.7" transform="rotate(12 16.4 25)" />
  </>;
}

/** Carbs: an ear of wheat, swaying on its stem. */
const KERNELS = [14, 20.5, 27];
function Wheat({ paint }: { paint: Paint }) {
  return <g className={styles.sway}>
    <path d="M24 44c0-12 .4-22 0-33" {...STROKE} strokeWidth="1.8" />
    <path d="M24 38c-3.8-.8-6.6-3.6-7.6-7.4" {...STROKE} strokeWidth="1.4" strokeOpacity="0.6" />
    <ellipse cx="24" cy="8.6" rx="2.4" ry="4.4" fill={url(paint.vol)} />
    {KERNELS.map((y) => <g key={y}>
      <ellipse cx="20.4" cy={y} rx="2.5" ry="4.6" transform={`rotate(-34 20.4 ${y})`} fill={url(paint.vol)} />
      <ellipse cx="27.6" cy={y} rx="2.5" ry="4.6" transform={`rotate(34 27.6 ${y})`} fill={url(paint.vol)} />
    </g>)}
    <path d="M19.4 12.6c.2-1.4.8-2.4 1.6-3.2" {...SHEEN} strokeWidth="0.9" />
  </g>;
}

/** Protein: a fried egg, the yolk gently swelling. */
function Egg({ paint }: { paint: Paint }) {
  const white = "M24 7c6 0 8.5 4 12.5 5.5 4.5 1.7 5.5 7 3.5 11-1.6 3.2-.4 6-2 9.5-2 4.4-7.6 7.5-13.5 7.5-6.5 0-12.6-2.6-15-7.6C8 28.6 7 26 7.4 21 7.8 15 12 13 15 10.5 17.6 8.3 20 7 24 7z";
  return <>
    <path d={white} fill="currentColor" fillOpacity="0.16" />
    <path d={white} {...STROKE} strokeWidth="1.2" strokeOpacity="0.75" />
    <circle className={styles.core} cx="23.5" cy="23.5" r="7.2" fill={url(paint.vol)} />
    <path d="M18.8 21.4a5.2 5.2 0 0 1 3.6-3.8" {...SHEEN} strokeWidth="1.2" />
    <circle className={styles.hot} cx="20.8" cy="20.8" r="1.4" fillOpacity="0.8" />
  </>;
}

/** Fat: half an avocado, its pit catching the light, the whole fruit settling as it turns. */
function Avocado({ paint }: { paint: Paint }) {
  const skin = "M24 5c5 0 7.5 4.5 8.5 9 1 4.2 5.5 8 5.5 15 0 8-6.2 14-14 14S10 37 10 29c0-7 4.5-10.8 5.5-15 1-4.5 3.5-9 8.5-9z";
  const flesh = "M24 9.2c3.5 0 5.2 3.3 6.1 7 .9 4 4.9 7.3 4.9 12.8 0 6.2-4.9 10.8-11 10.8S13 35.2 13 29c0-5.5 4-8.8 4.9-12.8.9-3.7 2.6-7 6.1-7z";
  return <g className={styles.molten}>
    <path d={skin} fill={url(paint.vol)} />
    <path className={styles.hot} d={flesh} fillOpacity="0.85" />
    <path d={flesh} fill="currentColor" fillOpacity="0.3" />
    <circle cx="24" cy="29" r="6" fill={url(paint.vol)} />
    <path d="M20.6 27a4.4 4.4 0 0 1 2.8-2.6" {...SHEEN} strokeWidth="1.1" />
  </g>;
}

/** Water: a glass globule that sloshes and breathes, a crisp rim round it, trailed by two drops. */
const DROP = "M24 5c5 8 12 14 12 23a12 12 0 0 1-24 0c0-9 7-15 12-23z";
function Globule({ level, id, paint }: { level: number; id: string; paint: Paint }) {
  const clip = `orbit-drop-${id}`;
  const surface = 40 - 34 * Math.min(1, Math.max(0, level));
  return <>
    <g className={styles.globule}>
      <defs><clipPath id={clip}><path d={DROP} /></clipPath></defs>
      <path d={DROP} fill={url(paint.vol)} fillOpacity="0.35" />
      <g clipPath={`url(#${clip})`}>
        <g className={styles.slosh}>
          <path d={`M-12 ${surface}c5-3 9 3 14 0s9 3 14 0 9 3 14 0 9 3 14 0 9 3 14 0V48H-12z`}
            fill="currentColor" fillOpacity="0.8" />
        </g>
      </g>
      <path d={DROP} {...STROKE} strokeWidth="0.8" strokeOpacity="0.85" />
      <path d="M17.5 21c1.2-3.4 3.2-6.6 5.4-9.4" {...SHEEN} strokeWidth="1.3" />
      <ellipse className={styles.hot} cx="18.6" cy="27" rx="1.4" ry="3" fillOpacity="0.7" transform="rotate(20 18.6 27)" />
    </g>
    <circle className={styles.bob} cx="39" cy="37" r="3.2" fill={url(paint.vol)} />
    <circle className={styles.bob} cx="8" cy="41" r="2" fill="currentColor" fillOpacity="0.5" style={lag(1.3)} />
  </>;
}

/** Activity: a layered flame, its tongues fading to the tip and flickering apart, embers rising. */
function Flame({ paint }: { paint: Paint }) {
  return <>
    <path className={styles.flameOuter} d="M24 3c2 8 12 12 12 24a12 12 0 0 1-24 0c0-6 3-10 6-13 0 4 2 7 4 8 0-7-1-13 2-19z"
      fill={url(paint.rise)} />
    <path className={styles.flameInner} d="M24 17c1 5 7 8 7 15a7 7 0 0 1-14 0c0-4 2-6 4-8 0 3 1 4 2 5 0-4 0-8 1-12z"
      fill="currentColor" fillOpacity="0.9" />
    <path className={`${styles.hot} ${styles.flameInner}`} d="M24 29c2 2 3.5 4 3.5 6.5a3.5 3.5 0 0 1-7 0c0-2.5 1.5-4.5 3.5-6.5z"
      fillOpacity="0.9" style={lag(0.3)} />
    <circle className={styles.ember} cx="17" cy="14" r="1.1" fill="currentColor" />
    <circle className={styles.ember} cx="30" cy="11" r="0.9" fill="currentColor" style={lag(0.7)} />
    <circle className={`${styles.ember} ${styles.hot}`} cx="24" cy="6" r="0.8" style={lag(1.4)} />
  </>;
}

/** Recovery: a lit crescent with a crisp rim, lighting the edge of a drifting cloud, a star near it. */
function Crescent({ paint }: { paint: Paint }) {
  const moon = "M29 7a15 15 0 1 0 12 23A12 12 0 0 1 29 7z";
  return <>
    <g className={styles.moon}>
      <path d={moon} fill={url(paint.vol)} />
      <path d={moon} {...STROKE} strokeWidth="0.7" strokeOpacity="0.8" />
      <path d="M22.5 9.5a13 13 0 0 0-8.4 9.8" {...SHEEN} strokeWidth="1.2" />
    </g>
    <g className={styles.cloud}>
      <path d="M7 38a6 6 0 0 1 6-6 8 8 0 0 1 15 .5 5.5 5.5 0 0 1 1 11H13a6 6 0 0 1-6-5.5z" fill="currentColor" fillOpacity="0.32" />
      <path d="M13 32a8 8 0 0 1 15 .5" {...STROKE} strokeWidth="1.5" strokeOpacity="0.9" />
    </g>
    <path className={`${styles.hot} ${styles.star}`} d="M40 5l1.2 3.3 3.3 1.2-3.3 1.2L40 14l-1.2-3.3-3.3-1.2 3.3-1.2z" />
  </>;
}

/** One living entity. `level` (0..1) sets the water line; the others ignore it. */
export default function OrbitMark({ kind, level = 0, size = 44 }: { kind: OrbitKey; level?: number; size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const paint: Paint = { vol: `orbit-vol-${id}`, rise: `orbit-rise-${id}` };
  const art = {
    calories: <Apple paint={paint} />, carbs: <Wheat paint={paint} />, protein: <Egg paint={paint} />, fat: <Avocado paint={paint} />,
    water: <Globule level={level} id={id} paint={paint} />, activity: <Flame paint={paint} />,
    recovery: <Crescent paint={paint} />,
  }[kind];
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false"
      shapeRendering="geometricPrecision" className={`${styles.mark} ${MARK_TEXT[kind]}`} data-kind={kind}>
      <defs>
        <radialGradient id={paint.vol} cx="0.38" cy="0.32" r="0.78">
          <stop offset="0" className={styles.stopHot} />
          <stop offset="0.3" stopColor="currentColor" />
          <stop offset="1" className={styles.stopDeep} />
        </radialGradient>
        <linearGradient id={paint.rise} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.75" />
          <stop offset="0.65" stopColor="currentColor" stopOpacity="0.45" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {art}
    </svg>
  );
}
