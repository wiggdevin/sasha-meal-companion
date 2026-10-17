"use client";

import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import Button from "@/components/ui/Button";
import { requestTiltPermission, subscribeTilt, useWaterTilt } from "@/components/today/useWaterTilt";
import { runFrames } from "@/components/today/frame-loop";
import { createSurface, heightAt, splash, stepSurface, surfaceEnergy } from "@/components/today/island/water-surface";
import { createWaterGl, tokenColour, type WaterColours, type WaterGl } from "@/components/today/island/water-gl";
import { createDye, dyeBusy, pack, squirt, stepDye } from "@/components/today/island/water-dye";
import WaterExtras, { INKS, INK_AFTER_MS, INK_MS, SPOUT } from "@/components/today/island/WaterExtras";
import WaterSwim from "@/components/today/island/WaterSwim";
import { surfacePath as path } from "@/components/today/island/water-path";
import { formatWater, waterNumber } from "@/lib/water-units";
import type { OrbitWater } from "@/lib/today/health-orbit";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import island from "@/components/today/island/Island.module.css";
import styles from "@/components/today/island/WellWater.module.css";

/** The level's spring: a little give, close to SPRINGS.bouncy. */
const STIFFNESS = 90;
const DAMPING = 10;
const GRAVITY = 1500;
const SIZE = { w: 350, h: 230 };
const DROPS = 14;
const SPLASH = 32;
const COLUMNS = 48;
/** Every so often the water stirs by itself a little while it is busy; once calm a moment it rests. */
const STIR_EVERY_S = 1.6;
/** Seconds of calm (the stir alone) before the frame loop sleeps; a splash, a pour, a tilt wakes it. */
const SETTLE_S = 4;

type Drop = { x: number; y: number; vy: number; r: number; at: number; live: boolean };
type Spray = { x: number; y: number; vx: number; vy: number; life: number; live: boolean };

/** The basin's fill: a puddle when empty, and at the goal it stops below the figure and the button. */
export function basinLevel(cups: number, goal: number): number {
  const share = goal > 0 && Number.isFinite(cups) ? Math.min(1, Math.max(0, cups / goal)) : 0;
  return 0.06 + share * 0.56;
}

/**
 * The open well's water (owner, 2026-10-06: "a great opportunity to show off fluid dynamics"; "look
 * a little more real and react to the tilt of the phone"). The bottom of the card is a basin of clear
 * slate jelly-water that rises with the day's cups. Its surface is a height field
 * (water-surface.ts): a drop pushes a column down and the wave travels, reflects off the glass and
 * fades; tilting the phone sloshes the water until it lies level with the ground (iOS asks once, on
 * the first tap in the basin). Adding a cup rains drops that splash where they land, and the level
 * springs up after them. One SVG, redrawn by one frame loop that writes attributes directly; it rests
 * when the basin is off screen, behind another face of the Day card, or motion is reduced.
 * At the goal the basin is full and stays full: more water updates the figure only.
 */
export default function WellWater({ water, onAddCup, paused = false }: {
  water?: OrbitWater; onAddCup?: () => void;
  /** Behind another Day card face (the face is inert): the loop and the tilt listener stop. */
  paused?: boolean;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const gradient = `well-water-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const box = useRef<HTMLDivElement | null>(null);
  const back = useRef<SVGPathElement>(null);
  const front = useRef<SVGPathElement>(null);
  const meniscus = useRef<SVGPathElement>(null);
  const light = useRef<SVGRectElement>(null);
  const clip = useRef<SVGPathElement>(null);
  const drops = useRef<(SVGEllipseElement | null)[]>([]);
  const sprays = useRef<(SVGCircleElement | null)[]>([]);
  const [onScreen, setOnScreen] = useState(true);
  const glCanvas = useRef<HTMLCanvasElement | null>(null);
  const gl = useRef<WaterGl | null>(null);
  const colours = useRef<WaterColours | null>(null);
  const drawStill = useRef<() => void>(() => {});
  const [glReady, setGlReady] = useState(false);
  const [glAttempt, setGlAttempt] = useState(0);
  const [pour, setPour] = useState({ water: 0, dye: 0 });
  const cups = water?.cups ?? 0;
  const goal = water?.goal ?? 0;
  const level = basinLevel(cups, goal);
  const sim = useRef({ y: level, v: 0, target: level, size: SIZE, surface: createSurface(COLUMNS),
    dye: createDye(), inksAt: 0, heightBytes: new Uint8Array(COLUMNS),
    drops: Array.from({ length: DROPS }, (): Drop => ({ x: 0, y: 0, vy: 0, r: 0, at: 0, live: false })),
    sprays: Array.from({ length: SPLASH }, (): Spray => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, live: false })) });
  const wake = useRef<() => void>(() => {});
  const lastCups = useRef(cups);
  const animate = !reduce && onScreen && !paused;
  const tilt = useWaterTilt(animate);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) { sim.current.size = { w: width, h: height }; wake.current(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The WebGL water: built once, rebuilt after a lost context, sized with the basin.
  useEffect(() => {
    const el = glCanvas.current;
    if (!el || typeof window === "undefined") return;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      el.width = Math.round((el.clientWidth || SIZE.w) * dpr);
      el.height = Math.round((el.clientHeight || SIZE.h) * dpr);
    };
    fit();
    gl.current = createWaterGl(el);
    // Read the tokens on the canvas itself, not the document root: a matte or dark-mode ancestor
    // can override them, and the shader should draw whatever colour actually cascades in here.
    colours.current = {
      top: tokenColour(el, "--color-gauge-water-end", [0.64, 0.77, 0.82]),
      deep: tokenColour(el, "--color-gauge-water", [0.43, 0.62, 0.7]).map((c) => c * 0.32),
      light: tokenColour(el, "--color-on-olive", [0.95, 0.93, 0.89]),
      orange: tokenColour(el, "--color-gauge-calories", [0.83, 0.42, 0.22]),
      plum: tokenColour(el, "--color-gauge-protein", [0.54, 0.46, 0.69]),
      orangeEnd: tokenColour(el, "--color-gauge-calories-end", [0.9, 0.6, 0.45]),
      plumEnd: tokenColour(el, "--color-gauge-protein-end", [0.7, 0.65, 0.81]),
    };
    setGlReady(Boolean(gl.current));
    // A rebuilt context starts blank, and a sleeping loop would leave it so.
    wake.current();
    // The SVG fallback shows from here on; a sleeping loop would leave it at an old level.
    const onLost = (event: Event) => { event.preventDefault(); gl.current = null; setGlReady(false); wake.current(); };
    const onRestored = () => setGlAttempt((n) => n + 1);
    el.addEventListener("webglcontextlost", onLost);
    el.addEventListener("webglcontextrestored", onRestored);
    // Resizing a canvas clears it; with no frame loop running (still water) redraw the one frame.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { fit(); drawStill.current(); wake.current(); });
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      el.removeEventListener("webglcontextlost", onLost);
      el.removeEventListener("webglcontextrestored", onRestored);
      try { gl.current?.dispose(); } catch { /* a lost context has nothing left to free */ }
      gl.current = null;
    };
  }, [glAttempt]);

  // A new cup: a shower of drops from above, the level following them down.
  useEffect(() => {
    const s = sim.current;
    const before = lastCups.current;
    lastCups.current = cups;
    s.target = level;
    wake.current();
    if (!animate || cups <= before || typeof performance === "undefined") return;
    const now = performance.now();
    const { w, h } = s.size;
    // Sprout tips its bucket: the water leaves the bucket's mouth once it has tipped. Near the goal
    // (80 % and up), once the bucket is done, two bottles squirt their inks in from the side walls.
    const dye = goal > 0 && cups / goal >= 0.8;
    setPour((p) => ({ water: p.water + 1, dye: p.dye + (dye ? 1 : 0) }));
    if (dye) s.inksAt = now + INK_AFTER_MS;
    let spawned = 0;
    for (const drop of s.drops) {
      if (drop.live || spawned >= 9) continue;
      Object.assign(drop, { live: true, x: w * SPOUT.x + (Math.random() - 0.5) * 10, y: h * SPOUT.y,
        vy: 30 + Math.random() * 60, r: 2.6 + Math.random() * 2.4, at: now + 380 + spawned * 70 });
      spawned += 1;
    }
  }, [cups, goal, level, animate]);

  useEffect(() => {
    if (!animate || typeof requestAnimationFrame === "undefined") return;
    const s = sim.current;
    let last = performance.now();
    let t = 0;
    let stir = 0;
    let calmFor = 0;
    // Calm water (no drops, no ink, the level settled, only the gentle stir) draws every other frame:
    // at rest it needs half the work, and after SETTLE_S of calm it sleeps. The last frame's state
    // decides, and a skipped frame's time carries into the next.
    let calm = false;
    let skip = false;
    const ysFront = new Array<number>(COLUMNS).fill(0);
    const ysBack = new Array<number>(COLUMNS).fill(0);
    const glFrame = { heights: s.heightBytes, columns: COLUMNS, dye: null as Uint8Array | null,
      dyeSize: [s.dye.nx, s.dye.ny] as [number, number], base: 0, size: [0, 0] as [number, number], time: 0,
      colours: null as WaterColours | null };
    const draw = (now: number): boolean => {
      skip = calm && !skip;
      if (skip) return true;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      t += dt;
      s.v += (STIFFNESS * (s.target - s.y) - DAMPING * s.v) * dt;
      s.y += s.v * dt;
      const { w, h } = s.size;
      const baseY = h * (1 - s.y);
      // The stir stops once the water has been calm a moment, so the loop can settle.
      if ((stir += dt) > STIR_EVERY_S && calmFor < 1) {
        stir = 0;
        splash(s.surface, Math.random() * w, w, (Math.random() - 0.5) * 50);
      }
      stepSurface(s.surface, dt, tilt.current ?? 0, w);
      const energy = surfaceEnergy(s.surface);
      for (let i = 0; i < COLUMNS; i += 1) {
        const x = (i / (COLUMNS - 1)) * w;
        const swell = 1.2 * Math.sin(x / 38 - t * 1.6);
        ysFront[i] = baseY + s.surface.heights[i] + swell;
        // The far surface: the same water seen a little behind, calmer and offset.
        ysBack[i] = baseY - 3 + s.surface.heights[Math.min(COLUMNS - 1, i + 2)] * 0.85
          + 1.4 * Math.sin(x / 52 + t * 1.1 + 1);
      }
      // The inks: when the bottles are in place, each squirts from its own wall, a beat apart, so the
      // two jets meet, curl round each other and mix (water-dye.ts steps in fixed time).
      if (s.inksAt && now >= s.inksAt) {
        s.inksAt = 0;
        for (const ink of INKS) squirt(s.dye, ink.jet, INK_MS / 1000);
      }
      const dyeOn = dyeBusy(s.dye);
      if (dyeOn) stepDye(s.dye, dt);
      if (gl.current && colours.current) {
        // The basin may have grown since the canvas was sized (the well opening): keep its pixels true.
        const c = glCanvas.current;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (c && (Math.abs(c.width - w * dpr) > 2 || Math.abs(c.height - h * dpr) > 2)) {
          c.width = Math.round(w * dpr);
          c.height = Math.round(h * dpr);
        }
        for (let i = 0; i < COLUMNS; i += 1) s.heightBytes[i] = Math.max(0, Math.min(255, ((ysFront[i] - baseY) + 16) / 32 * 255));
        glFrame.dye = dyeOn ? pack(s.dye) : null;
        glFrame.base = baseY;
        glFrame.size[0] = w;
        glFrame.size[1] = h;
        glFrame.time = t;
        glFrame.colours = colours.current;
        gl.current.draw(glFrame as Parameters<WaterGl["draw"]>[0]);
      }
      // The SVG water stands in only without WebGL (data-gl hides it otherwise): leave its paths alone
      // while the shader draws.
      if (!gl.current) {
        const fp = path(w, h, ysFront);
        back.current?.setAttribute("d", path(w, h, ysBack).body);
        front.current?.setAttribute("d", fp.body);
        clip.current?.setAttribute("d", fp.body);
        meniscus.current?.setAttribute("d", fp.line);
        meniscus.current?.setAttribute("stroke-opacity", Math.min(1, 0.55 + energy / 60).toFixed(2));
        light.current?.setAttribute("transform", `translate(${(((t * 38) % (w * 1.6)) - w * 0.5).toFixed(1)} 0) skewX(-18)`);
      }
      const surfaceAt = (x: number) => baseY + heightAt(s.surface, x, w);

      s.drops.forEach((drop, i) => {
        const el = drops.current[i];
        if (!el) return;
        if (!drop.live || now < drop.at) { el.setAttribute("opacity", "0"); return; }
        drop.vy += GRAVITY * dt;
        drop.y += drop.vy * dt;
        const floor = surfaceAt(drop.x);
        if (drop.y >= floor) {
          drop.live = false;
          el.setAttribute("opacity", "0");
          splash(s.surface, drop.x, w, 40 + drop.r * 28);
          let thrown = 0;
          for (const spray of s.sprays) {
            if (spray.live || thrown >= 4) continue;
            const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
            const speed = 140 + Math.random() * 160;
            Object.assign(spray, { live: true, x: drop.x, y: floor, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
              life: 0.7 });
            thrown += 1;
          }
          return;
        }
        const stretch = 1 + Math.min(1.6, drop.vy / 700);
        el.setAttribute("cx", drop.x.toFixed(1));
        el.setAttribute("cy", drop.y.toFixed(1));
        el.setAttribute("rx", drop.r.toFixed(1));
        el.setAttribute("ry", (drop.r * stretch).toFixed(1));
        el.setAttribute("opacity", "1");
      });

      s.sprays.forEach((spray, i) => {
        const el = sprays.current[i];
        if (!el) return;
        if (!spray.live) { el.setAttribute("opacity", "0"); return; }
        spray.vy += GRAVITY * 0.8 * dt;
        spray.x += spray.vx * dt;
        spray.y += spray.vy * dt;
        spray.life -= dt;
        const floor = surfaceAt(spray.x);
        if (spray.life <= 0 || (spray.vy > 0 && spray.y > floor)) { spray.live = false; el.setAttribute("opacity", "0"); return; }
        el.setAttribute("cx", spray.x.toFixed(1));
        el.setAttribute("cy", spray.y.toFixed(1));
        el.setAttribute("opacity", Math.min(1, spray.life * 2).toFixed(2));
      });
      // Below 4 (surfaceEnergy's units) is the stir alone; a tap's splash runs 10-20 for a second.
      calm = energy < 4 && !dyeOn && !s.inksAt && Math.abs(s.target - s.y) < 0.002 && Math.abs(s.v) < 0.01
        && !s.drops.some((drop) => drop.live) && !s.sprays.some((spray) => spray.live);
      calmFor = calm ? calmFor + dt : 0;
      return calmFor < SETTLE_S;
    };
    const loop = runFrames(draw);
    wake.current = () => { calmFor = 0; calm = false; loop.wake(); };
    const unsubscribe = subscribeTilt(() => wake.current());
    return () => { unsubscribe(); wake.current = () => {}; loop.stop(); };
  }, [animate, tilt]);

  // Still water: the level at once, flat, nothing falling. Kept in `drawStill` so a resize, which
  // clears the canvas, can draw it again.
  useEffect(() => {
    if (animate) { drawStill.current = () => {}; return; }
    drawStill.current = () => {
      const s = sim.current;
      s.y = level;
      s.v = 0;
      const c = glCanvas.current;
      if (c && c.clientWidth > 0 && c.clientHeight > 0) s.size = { w: c.clientWidth, h: c.clientHeight };
      const { w, h } = s.size;
      const ys = Array.from({ length: 2 }, () => h * (1 - level));
      const flat = path(w, h, ys);
      back.current?.setAttribute("d", flat.body);
      front.current?.setAttribute("d", flat.body);
      clip.current?.setAttribute("d", flat.body);
      meniscus.current?.setAttribute("d", flat.line);
      for (const el of drops.current) el?.setAttribute("opacity", "0");
      for (const el of sprays.current) el?.setAttribute("opacity", "0");
      if (gl.current && colours.current) {
        s.heightBytes.fill(128);
        gl.current.draw({ heights: s.heightBytes, columns: COLUMNS, dye: null, dyeSize: [s.dye.nx, s.dye.ny],
          base: h * (1 - level), size: [w, h], time: 0, colours: colours.current });
      }
    };
    drawStill.current();
  }, [animate, level, glReady]);

  // Sprout swims through the glass (WaterSwim): on a double tap in the water, and now and then on its own.
  const [swims, setSwims] = useState(0);
  const lastTap = useRef(Number.NEGATIVE_INFINITY);
  const splashAt = (x: number, strength: number) => { const s = sim.current; splash(s.surface, x * s.size.w, s.size.w, strength); wake.current(); };

  const unit = water?.unit ?? "cups";
  const reached = water ? water.cups >= water.goal && water.goal > 0 : false;
  const first = path(SIZE.w, SIZE.h, [SIZE.h * (1 - level), SIZE.h * (1 - level)]);
  // A tap in the water plays with it (a splash where the finger lands); above the waterline, on the
  // glass, it folds the well like anywhere else.
  const poke = (event: MouseEvent<HTMLDivElement>) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !animate || (event.target as HTMLElement).closest("button")) return;
    const s = sim.current;
    const x = event.clientX - rect.left;
    const waterline = rect.height * (1 - s.y) + heightAt(s.surface, x, rect.width);
    if (event.clientY - rect.top < waterline - 8) return;
    event.stopPropagation();
    splash(s.surface, x, rect.width, 120);
    wake.current();
    if (event.timeStamp - lastTap.current < 350) setSwims((n) => n + 1);
    lastTap.current = event.timeStamp;
  };
  return <div ref={box} className={styles.basin} data-gl={glReady || undefined} onPointerDown={requestTiltPermission} onClick={poke}>
    <canvas ref={glCanvas} aria-hidden="true" className={styles.gl} />
    <WaterExtras pours={pour.water} dyes={pour.dye} surface={1 - level} />
    <WaterSwim run={swims} active={animate} auto={level >= 0.25} surface={1 - level} onSplash={splashAt} />
    <svg aria-hidden="true" focusable="false" className={styles.svg}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className={styles.stopTop} />
          <stop offset="0.07" className={styles.stopMid} />
          <stop offset="1" className={styles.stopDeep} />
        </linearGradient>
        <linearGradient id={`${gradient}-light`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" className={styles.lightEdge} />
          <stop offset="0.5" className={styles.lightCore} />
          <stop offset="1" className={styles.lightEdge} />
        </linearGradient>
        <clipPath id={`${gradient}-clip`}><path ref={clip} d={first.body} /></clipPath>
      </defs>
      <path ref={back} className={styles.back} d={first.body} />
      <path ref={front} className={styles.front} d={first.body} fill={`url(#${gradient})`} />
      <g clipPath={`url(#${gradient}-clip)`} className={styles.lightBand}>
        <rect ref={light} fill={`url(#${gradient}-light)`} x="0" y="0" width="90" height="100%" />
      </g>
      <path ref={meniscus} className={styles.meniscus} d={first.line} />
      {Array.from({ length: DROPS }, (_, i) => <ellipse key={`d${i}`} ref={(el) => { drops.current[i] = el; }}
        className={styles.drop} cx={0} cy={0} rx={3} ry={3} opacity={0} />)}
      {Array.from({ length: SPLASH }, (_, i) => <circle key={`s${i}`} ref={(el) => { sprays.current[i] = el; }}
        className={styles.spray} cx={0} cy={0} r={1.8} opacity={0} />)}
    </svg>
    <div className={styles.readout} aria-hidden="true">
      <span className={styles.figureLine}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={cups} className={styles.figure}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -16, scale: 0.8 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.9 }} transition={reduce ? INSTANT : SPRINGS.bouncy}>
            {water ? waterNumber(water.cups, unit) : "…"}
          </motion.span>
        </AnimatePresence>
        <span className={styles.word}>{water ? `of ${formatWater(water.goal, unit)}` : "water"}</span>
      </span>
      {water && <span className={styles.meta}>{reached ? "Goal reached" : `${formatWater(water.goal - water.cups, unit)} to go`}</span>}
    </div>
    {onAddCup && <Button variant="secondary" size="sm" onClick={(event) => { event.stopPropagation(); onAddCup(); }}
      className={`${island.cup} ${styles.add}`}>Add a cup</Button>}
  </div>;
}
