"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { BOX, CLOUDS, HORIZON, KEY, RAINBOW, groundFromBox, type Band } from "@/components/today/scene/scene-geometry";
import { createPondGl, type PondGl } from "@/components/today/scene/pond-gl";
import { runFrames } from "@/components/today/frame-loop";
import { subscribeTilt } from "@/components/today/useWaterTilt";
import styles from "@/components/today/scene/PondScene.module.css";

/** What the scene can ask of the water. */
export type PondApi = { splash: (x: number, y: number, strength: number) => void };
export type KeyRow = { band: Band; value: string; label: string };

/** The ground grid (columns across, rows toward the horizon) and its wave physics, in cells. */
const COLS = 128;
const ROWS = 72;
const WAVE_SPEED = 30;
const DAMPING = 1.5;
const STEP = 1 / 60;
const NORMAL_GAIN = 0.55;
/** The water redraws at 30 frames a second; the controls on top keep their own 60. */
const FRAME_MS = 1000 / 30;
const MIRROR = 0.55;
/** Seconds without a splash or a tilt before the stirring stops, and the ripples' speed under which the loop sleeps. */
const QUIET_S = 6;
const STILL_SPEED = 0.02;
const BAND_TOKEN: Record<Band, string> = {
  kcal: "--color-gauge-calories", protein: "--color-gauge-protein", carbs: "--color-gauge-carbs", fat: "--color-gauge-fat",
};

/** The reflections the water shows: the rainbow and clouds mirrored at the horizon, and the key's ghost. */
function paintReflection(target: HTMLCanvasElement, shares: Record<Band, number>, bands: readonly Band[],
  clouds: HTMLImageElement[], keyRows: KeyRow[] | null) {
  const ctx = target.getContext("2d");
  if (!ctx) return;
  const k = target.width / BOX.w;
  const css = getComputedStyle(document.documentElement);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.setTransform(k, 0, 0, -k * MIRROR, 0, k * HORIZON * (1 + MIRROR));
  ctx.lineCap = "round";
  bands.forEach((band, i) => {
    const share = shares[band];
    if (share <= 0) return;
    ctx.strokeStyle = css.getPropertyValue(BAND_TOKEN[band]).trim() || "white";
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = RAINBOW.band;
    ctx.beginPath();
    ctx.arc(RAINBOW.cx, RAINBOW.cy, RAINBOW.radii[i], Math.PI, Math.PI + Math.PI * share);
    ctx.stroke();
  });
  ctx.globalAlpha = 0.3;
  CLOUDS.forEach((cloud, i) => {
    const img = clouds[i];
    if (img?.complete && img.naturalWidth) ctx.drawImage(img, cloud.x, cloud.y, cloud.w, cloud.w * img.naturalHeight / img.naturalWidth);
  });
  if (keyRows) {
    // The key's ghost lies just under it, upside down, faint: the water ripples it; the real key stays crisp.
    const bottom = KEY.y + 20 + keyRows.length * 18;
    ctx.setTransform(k, 0, 0, -k, 0, k * bottom * 2);
    ctx.globalAlpha = 0.28;
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = css.getPropertyValue("--color-on-olive").trim() || "white";
    ctx.fillText("remaining", KEY.x + 10, KEY.y + 16);
    keyRows.forEach((row, i) => {
      ctx.fillStyle = css.getPropertyValue(BAND_TOKEN[row.band]).trim() || "white";
      ctx.fillText(`${row.value} ${row.label}`, KEY.x + 10, KEY.y + 34 + i * 18);
    });
  }
  ctx.globalAlpha = 1;
}

/**
 * The pond's water: a canvas over the painted lake, a ripple simulation on the lake's ground plane
 * (a damped wave equation on a 128 × 72 grid, its normals sent to pond-gl.ts each frame), a breeze
 * that never stops, and the phone's tilt leaning the light. It runs at 30 fps only while `animate`
 * (on screen, the Day face showing, motion allowed); otherwise one still frame. Without WebGL it
 * draws nothing and the painted lake stands in.
 */
export default function PondWater({ shares, bands, keyRows, animate, tilt, controlRef }: {
  shares: Record<Band, number>; bands: readonly Band[]; keyRows: KeyRow[] | null; animate: boolean;
  tilt: RefObject<number>; controlRef: RefObject<PondApi | null>;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const gl = useRef<PondGl | null>(null);
  const mirror = useRef<HTMLCanvasElement | null>(null);
  const wake = useRef<() => void>(() => {});
  const stirring = useRef(false);
  const clouds = useRef<HTMLImageElement[]>([]);
  const sim = useRef({ h: new Float32Array(COLS * ROWS), v: new Float32Array(COLS * ROWS),
    normals: new Uint8Array(COLS * ROWS * 4).fill(128), lean: 0 });
  const [ready, setReady] = useState(false);
  // A lost WebGL context comes back by building everything again.
  const [attempt, setAttempt] = useState(0);
  const drawOnce = useRef<() => void>(() => {});
  const latest = useRef({ shares, bands, keyRows });
  const paint = useRef(() => {
    if (!mirror.current || !gl.current) return;
    const { shares: s, bands: b, keyRows: k } = latest.current;
    paintReflection(mirror.current, s, b, clouds.current, k);
    gl.current.setReflection(mirror.current);
    drawOnce.current();
  });

  // The program, its lake bed and the reflection canvas; again after a context loss.
  useEffect(() => {
    const el = canvas.current;
    if (!el || typeof window === "undefined") return;
    let disposed = false;
    const bed = new Image();
    bed.decoding = "async";
    clouds.current = CLOUDS.map((c) => { const img = new Image(); img.src = c.src; return img; });
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = el.clientWidth || BOX.w;
      const w = Math.round(width * dpr);
      const h = Math.round(width * (BOX.h / BOX.w) * dpr);
      if (el.width === w && el.height === h && mirror.current?.width === w) return false;
      el.width = w;
      el.height = h;
      if (mirror.current) { mirror.current.width = w; mirror.current.height = h; }
      return true;
    };
    const onLost = (event: Event) => { event.preventDefault(); gl.current = null; setReady(false); };
    const onRestored = () => setAttempt((n) => n + 1);
    el.addEventListener("webglcontextlost", onLost);
    el.addEventListener("webglcontextrestored", onRestored);
    bed.onload = () => {
      if (disposed) return;
      mirror.current = document.createElement("canvas");
      fit();
      gl.current = createPondGl(el, bed);
      setReady(Boolean(gl.current));
    };
    bed.src = "/pet/scene/pond-sky.webp";
    // The card's width changes (rotation, split view): resize both canvases and repaint.
    const observer = typeof ResizeObserver === "undefined" ? null
      : new ResizeObserver(() => { if (gl.current && fit()) paint.current(); });
    observer?.observe(el);
    // A move to a screen of another density (an external display) changes the backing size too.
    let density: MediaQueryList | null = null;
    const onDensity = () => {
      density?.removeEventListener("change", onDensity);
      if (gl.current && fit()) paint.current();
      density = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null;
      density?.addEventListener("change", onDensity);
    };
    density = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null;
    density?.addEventListener("change", onDensity);
    return () => {
      disposed = true;
      density?.removeEventListener("change", onDensity);
      bed.onload = null;
      observer?.disconnect();
      el.removeEventListener("webglcontextlost", onLost);
      el.removeEventListener("webglcontextrestored", onRestored);
      try { gl.current?.dispose(); } catch { /* a lost context has nothing left to free */ }
      gl.current = null;
    };
  }, [attempt]);

  // Reflections follow the rainbow and the key.
  useEffect(() => {
    latest.current = { shares, bands, keyRows };
    if (!ready) return;
    paint.current();
    // Clouds may still be loading the first time.
    const late = setTimeout(() => paint.current(), 600);
    return () => clearTimeout(late);
  }, [ready, shares, bands, keyRows]);

  // The scene's handle: a splash on the water at a box point (the lure, a tap, a rock).
  useEffect(() => {
    controlRef.current = {
      splash(x, y, strength) {
        const at = groundFromBox(x, y);
        if (!at) return;
        if (!stirring.current) wake.current();
        const i0 = Math.round(at.gx * (COLS - 1));
        const j0 = Math.round(at.gz * (ROWS - 1));
        for (let dj = -2; dj <= 2; dj += 1) for (let di = -2; di <= 2; di += 1) {
          const i = i0 + di; const j = j0 + dj;
          if (i < 1 || j < 1 || i >= COLS - 1 || j >= ROWS - 1) continue;
          sim.current.v[j * COLS + i] -= strength * Math.exp(-(di * di + dj * dj) / 2);
        }
      },
    };
    return () => { controlRef.current = null; };
  }, [controlRef]);

  useEffect(() => {
    if (!ready) return;
    const s = sim.current;
    const step = (dt: number) => {
      const { h, v } = s;
      let left = dt;
      while (left > 0) {
        const t = Math.min(STEP, left);
        left -= t;
        for (let j = 1; j < ROWS - 1; j += 1) {
          for (let i = 1; i < COLS - 1; i += 1) {
            const k = j * COLS + i;
            const lap = h[k - 1] + h[k + 1] + h[k - COLS] + h[k + COLS] - 4 * h[k];
            v[k] += (WAVE_SPEED * WAVE_SPEED * lap - DAMPING * v[k]) * t;
          }
        }
        for (let k = 0; k < h.length; k += 1) h[k] += v[k] * t;
      }
      for (let j = 1; j < ROWS - 1; j += 1) {
        for (let i = 1; i < COLS - 1; i += 1) {
          const k = j * COLS + i;
          const nx = Math.max(-1, Math.min(1, (h[k - 1] - h[k + 1]) * NORMAL_GAIN));
          const nz = Math.max(-1, Math.min(1, (h[k - COLS] - h[k + COLS]) * NORMAL_GAIN));
          s.normals[k * 4] = nx * 127.5 + 127.5;
          s.normals[k * 4 + 1] = nz * 127.5 + 127.5;
        }
      }
    };
    const render = (time: number) => gl.current?.draw(s.normals, COLS, ROWS, time, s.lean);
    drawOnce.current = () => render(performance.now() / 1000);
    if (!animate) { render(0); return; }
    let last = performance.now();
    let stir = 0;
    // Settled: nothing has disturbed the water for QUIET_S (the stirring stops), the ripples have
    // died and the lean has caught the phone. The loop then sleeps until a splash or a tilt.
    let quiet = 0;
    const frame = (now: number): boolean => {
      if (now - last < FRAME_MS) return true;
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      // The phone's lean eases in, so a turn sends a slow sway rather than a jump.
      s.lean += ((tilt.current ?? 0) / 15 - s.lean) * (1 - Math.exp(-dt / 0.55));
      // Now and then a small stir, so the lake is alive without busy rings everywhere.
      quiet += dt;
      if (quiet < QUIET_S && (stir += dt) > 3.2) {
        stir = 0;
        stirring.current = true;
        controlRef.current?.splash(40 + Math.random() * 280, HORIZON + 50 + Math.random() * 130, 2 + Math.random() * 2);
        stirring.current = false;
      }
      step(dt);
      render(now / 1000);
      if (quiet < QUIET_S) return true;
      let fastest = 0;
      for (let k = 0; k < s.v.length; k += 1) fastest = Math.max(fastest, Math.abs(s.v[k]));
      return fastest > STILL_SPEED || Math.abs((tilt.current ?? 0) / 15 - s.lean) > 0.005;
    };
    const loop = runFrames(frame);
    wake.current = () => { quiet = 0; loop.wake(); };
    const unsubscribe = subscribeTilt(() => wake.current());
    return () => { unsubscribe(); wake.current = () => {}; loop.stop(); };
  }, [ready, animate, tilt, controlRef]);

  return <canvas ref={canvas} aria-hidden="true" className={styles.water} data-ready={ready || undefined} />;
}
