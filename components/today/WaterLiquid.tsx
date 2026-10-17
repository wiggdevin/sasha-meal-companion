"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { liquidPath, sloshEnergy, smoothToward, type Wave } from "@/lib/today/water-liquid";
import { runFrames } from "@/components/today/frame-loop";
import { subscribeTilt } from "@/components/today/useWaterTilt";
import styles from "@/components/today/WaterTile.module.css";

/**
 * The water in the tile (2026-10-03): two layered sine waves over a soft blue-green fill, a gentle
 * idle swell, a level that springs to each new amount and sloshes after it, small bubbles rising,
 * and a surface that leans with the phone. One SVG, redrawn by a frame loop that writes attributes
 * directly (no React render per frame) and runs only while `animate` is true: the board on show and
 * motion allowed. Otherwise the water is drawn still, level and flat.
 */

const BUBBLES = [
  { x: 0.16, r: 2.2, speed: 20, offset: 0.1 },
  { x: 0.38, r: 1.5, speed: 29, offset: 0.55 },
  { x: 0.57, r: 2.6, speed: 16, offset: 0.3 },
  { x: 0.74, r: 1.3, speed: 25, offset: 0.8 },
  { x: 0.88, r: 1.8, speed: 21, offset: 0.62 },
];

/** A light spring with a little give, close to SPRINGS.bouncy (lib/design/motion.ts). */
const STIFFNESS = 110;
const DAMPING = 11.5;
const DEFAULT_SIZE = { w: 200, h: 160 };
/** Seconds of calm before the frame loop sleeps (battery); a new level or a tilt wakes it. */
const SETTLE_S = 3;

function backWave(w: number, t: number, energy: number): Wave {
  return { amplitude: (1.8 + 3.2 * energy) * 0.8, wavelength: w * 0.92, phase: t * 1.5 + 1.2 };
}

function frontWave(w: number, t: number, energy: number): Wave {
  return { amplitude: 1.8 + 3.2 * energy, wavelength: w * 0.6, phase: -t * 2.2 };
}

export default function WaterLiquid({ level, tilt, animate }: {
  /** Fill height, 0..1 of the tile (lib/today/water-liquid.ts `fillFraction`). */
  level: number;
  /** Clamped device roll in degrees (components/today/useWaterTilt.ts). */
  tilt: RefObject<number>;
  animate: boolean;
}) {
  const gradient = `water-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const svg = useRef<SVGSVGElement>(null);
  const back = useRef<SVGPathElement>(null);
  const front = useRef<SVGPathElement>(null);
  const bubbles = useRef<(SVGCircleElement | null)[]>([]);
  const wake = useRef<() => void>(() => {});
  const sim = useRef({ y: level, v: 0, target: level, changedAt: -Infinity, size: DEFAULT_SIZE });
  // The first frame's paths, fixed for the element's life so a re-render never fights the loop.
  const [initial] = useState(() => {
    const { w, h } = DEFAULT_SIZE;
    const baseY = h * (1 - level);
    return { back: liquidPath(w, h, baseY - 2, 0, backWave(w, 0, 0)), front: liquidPath(w, h, baseY, 0, frontWave(w, 0, 0)) };
  });

  // Track the tile's real size so the waves and bubbles are drawn in its pixels, never stretched.
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        sim.current.size = { w: width, h: height };
        wake.current();
        el.setAttribute("viewBox", `0 0 ${width.toFixed(1)} ${height.toFixed(1)}`);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const s = sim.current;
    if (s.target !== level) {
      s.target = level;
      s.changedAt = typeof performance !== "undefined" ? performance.now() : 0;
      wake.current();
    }
    if (animate) return;
    // Still water: the new level at once, flat and level, no bubbles.
    s.y = level;
    s.v = 0;
    const { w, h } = s.size;
    const baseY = h * (1 - level);
    back.current?.setAttribute("d", liquidPath(w, h, baseY - 2, 0, { amplitude: 0, wavelength: w, phase: 0 }));
    front.current?.setAttribute("d", liquidPath(w, h, baseY, 0, { amplitude: 0, wavelength: w, phase: 0 }));
    for (const bubble of bubbles.current) bubble?.setAttribute("opacity", "0");
  }, [level, animate]);

  useEffect(() => {
    if (!animate || typeof requestAnimationFrame === "undefined") return;
    const s = sim.current;
    let last = performance.now();
    let t = 0;
    let lean = 0;
    // Settled: the level has landed, the slosh has died and the lean has caught the phone. The loop
    // sleeps a moment after that (the bubbles clear) and wakes on a new level, a tilt or a resize.
    let quiet = 0;
    const draw = (now: number): boolean => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      t += dt;
      s.v += (STIFFNESS * (s.target - s.y) - DAMPING * s.v) * dt;
      s.y += s.v * dt;
      const age = (now - s.changedAt) / 1000;
      const energy = sloshEnergy(age);
      lean = smoothToward(lean, tilt.current ?? 0, dt, 4);
      const rock = energy > 0.001 ? 6 * energy * Math.sin(age * 8) : 0;
      const { w, h } = s.size;
      const baseY = h * (1 - s.y);
      back.current?.setAttribute("d", liquidPath(w, h, baseY - 2, lean + rock * 0.7, backWave(w, t, energy)));
      front.current?.setAttribute("d", liquidPath(w, h, baseY, lean + rock, frontWave(w, t, energy)));
      const depth = h - baseY;
      BUBBLES.forEach((b, i) => {
        const el = bubbles.current[i];
        if (!el) return;
        const travel = Math.max(1, depth - 6);
        const risen = (t * b.speed + b.offset * travel) % travel;
        el.setAttribute("cx", (b.x * w + Math.sin(t * 2 + i) * 2).toFixed(1));
        el.setAttribute("cy", (h - 2 - risen).toFixed(1));
        // Bubbles fade out as they near the surface, and stay away in a near-empty glass.
        el.setAttribute("opacity", depth < 16 ? "0" : (0.6 * (1 - risen / travel)).toFixed(2));
      });
      const calm = energy <= 0.001 && Math.abs(s.target - s.y) < 0.002 && Math.abs(s.v) < 0.01
        && Math.abs(lean - (tilt.current ?? 0)) < 0.05;
      quiet = calm ? quiet + dt : 0;
      if (quiet < SETTLE_S) return true;
      // The settled frame: no bubbles left hanging part-way up still water.
      bubbles.current.forEach((el) => el?.setAttribute("opacity", "0"));
      return false;
    };
    const loop = runFrames(draw);
    wake.current = () => { quiet = 0; loop.wake(); };
    const unsubscribe = subscribeTilt(() => wake.current());
    return () => { unsubscribe(); wake.current = () => {}; loop.stop(); };
  }, [animate, tilt]);

  return (
    <svg ref={svg} aria-hidden="true" className={styles.liquid} viewBox={`0 0 ${DEFAULT_SIZE.w} ${DEFAULT_SIZE.h}`}
      preserveAspectRatio="none" focusable="false">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className={styles.stopTop} />
          <stop offset="1" className={styles.stopBottom} />
        </linearGradient>
      </defs>
      <path ref={back} className={styles.waveBack} d={initial.back} />
      <path ref={front} className={styles.waveFront} d={initial.front} fill={`url(#${gradient})`} />
      {BUBBLES.map((b, i) => (
        <circle key={i} ref={(el) => { bubbles.current[i] = el; }} className={styles.bubble}
          r={b.r} cx={b.x * DEFAULT_SIZE.w} cy={DEFAULT_SIZE.h} opacity={0} />
      ))}
    </svg>
  );
}
