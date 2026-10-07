"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import styles from "@/components/today/care/Awards.module.css";

/** What a scene can ask of the particle layer. Positions are in the scene's 350 × 420 box. */
export type SparksApi = {
  /** A burst of glowing sparks from a point, in the scene's tone (or a token colour). */
  burst: (x: number, y: number, count: number, colour?: string) => void;
  /** Flames licking up around a box for `seconds`. */
  fire: (x: number, y: number, w: number, h: number, seconds: number) => void;
};

type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number; colour: string;
  kind: "spark" | "flame" };

const BOX = { w: 350, h: 420 };
/** At most this many at once: a celebration, not a strobe (Astra §D: no more than 18 per burst). */
const MAX = 220;

/**
 * One canvas of light over a scene: sparks that fly, fall and fade, and flames that rise and flicker,
 * drawn additively so they glow on the dark glass. It runs only while something is alive, and draws
 * nothing under reduced motion (the scene shows its still poster instead).
 */
export default function Sparks({ ref, still = false }: { ref?: Ref<SparksApi>; still?: boolean }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const parts = useRef<Particle[]>([]);
  const frame = useRef(0);
  const flames = useRef<{ x: number; y: number; w: number; h: number; until: number }[]>([]);

  /** A colour token resolved on the canvas (the scene sets --tone; the CSS module sets the flame tones). */
  const token = (name: string) => (canvas.current ? getComputedStyle(canvas.current).getPropertyValue(name).trim() : "") || "white";

  const loop = useRef<(now: number) => void>(() => {});
  useEffect(() => { loop.current = (now: number) => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const k = el.width / BOX.w;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.globalCompositeOperation = "lighter";
    flames.current = flames.current.filter((f) => f.until > now);
    for (const f of flames.current) {
      for (let i = 0; i < 4 && parts.current.length < MAX; i += 1) {
        const hot = Math.random() < 0.35;
        parts.current.push({ x: f.x + Math.random() * f.w, y: f.y + f.h * (0.6 + Math.random() * 0.4), vx: (Math.random() - 0.5) * 30,
          vy: -60 - Math.random() * 90, life: 0, max: 0.5 + Math.random() * 0.5, r: 5 + Math.random() * 7,
          colour: token(hot ? "--flame-hot" : Math.random() < 0.5 ? "--flame-mid" : "--flame-deep"), kind: "flame" });
      }
    }
    const dt = 1 / 60;
    parts.current = parts.current.filter((p) => (p.life += dt) < p.max);
    for (const p of parts.current) {
      if (p.kind === "spark") { p.vy += 420 * dt; p.vx *= 0.985; } else { p.vx += (Math.random() - 0.5) * 20; p.vy *= 0.98; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const fade = 1 - p.life / p.max;
      const r = (p.kind === "flame" ? p.r * (0.5 + fade * 0.7) : p.r) * k;
      const g = ctx.createRadialGradient(p.x * k, p.y * k, 0, p.x * k, p.y * k, r);
      g.addColorStop(0, p.colour);
      g.addColorStop(1, "transparent");
      ctx.globalAlpha = p.kind === "flame" ? fade * 0.8 : fade;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x * k, p.y * k, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    frame.current = parts.current.length || flames.current.length ? requestAnimationFrame((t) => loop.current(t)) : 0;
  }; }, []);
  const wake = () => { if (!frame.current) frame.current = requestAnimationFrame((t) => loop.current(t)); };

  useImperativeHandle(ref, () => ({
    burst(x, y, count, colour) {
      if (still) return;
      const c = colour ?? token("--tone");
      for (let i = 0; i < Math.min(count, 18) && parts.current.length < MAX; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const speed = 120 + Math.random() * 220;
        parts.current.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 80, life: 0, max: 0.6 + Math.random() * 0.6,
          r: 2 + Math.random() * 3, colour: c, kind: "spark" });
      }
      wake();
    },
    fire(x, y, w, h, seconds) {
      if (still) return;
      flames.current.push({ x, y, w, h, until: performance.now() + seconds * 1000 });
      wake();
    },
  }), [still]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round((el.clientWidth || BOX.w) * dpr);
    el.height = Math.round((el.clientWidth || BOX.w) * (BOX.h / BOX.w) * dpr);
    return () => { if (frame.current) cancelAnimationFrame(frame.current); frame.current = 0; parts.current = []; };
  }, []);

  return <canvas ref={canvas} aria-hidden="true" className={styles.sparks} />;
}
