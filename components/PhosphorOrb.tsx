"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useReducedMotionConfig } from "motion/react";
import {
  canvasPixels, fragmentSource, orbQuality, rgbTriplet, VERTEX_SOURCE, type OrbQuality,
} from "@/lib/today/phosphor-orb";
import styles from "@/components/HealthOrbit.module.css";

/* The overview orb's living phosphor (Health Overview Orbit, 2026-09-30): the one WebGL2 canvas on
   Today. A CSS glow sits under it and is all that shows without WebGL2, before the first frame,
   and after a failed compile. The loop runs at the device's capped rate, pauses when the tab is
   hidden or the orb scrolls away, and draws one still frame under reduced motion. */

const noop = () => () => {};
const hasWebGL2 = () => typeof window !== "undefined" && typeof window.WebGL2RenderingContext !== "undefined";
const STILL_TIME = 2.4;
const FALLBACK_CORE: [number, number, number] = [0.38, 0.41, 0.31];
const FALLBACK_RIM: [number, number, number] = [0.54, 0.64, 0.43];
const FALLBACK_FIRE: [number, number, number] = [0.79, 0.64, 0.31];

function deviceQuality(): OrbQuality {
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return orbQuality({ coarse, dpr: window.devicePixelRatio || 1, cores: navigator.hardwareConcurrency || 4 });
}

type Scene = { program: WebGLProgram; vao: WebGLVertexArrayObject; buffer: WebGLBuffer;
  res: WebGLUniformLocation | null; time: WebGLUniformLocation | null; energy: WebGLUniformLocation | null };

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

/** Program, full-screen triangle and uniforms; null when anything fails, so the glow stays. */
function buildScene(gl: WebGL2RenderingContext, quality: OrbQuality, canvas: HTMLCanvasElement): Scene | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource(quality));
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) return null;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.useProgram(program);
  const css = getComputedStyle(canvas);
  gl.uniform3f(gl.getUniformLocation(program, "uCore"), ...rgbTriplet(css.getPropertyValue("--orb-core-rgb"), FALLBACK_CORE));
  gl.uniform3f(gl.getUniformLocation(program, "uRim"), ...rgbTriplet(css.getPropertyValue("--orb-rim-rgb"), FALLBACK_RIM));
  gl.uniform3f(gl.getUniformLocation(program, "uFire"), ...rgbTriplet(css.getPropertyValue("--orb-fire-rgb"), FALLBACK_FIRE));
  return { program, vao, buffer, res: gl.getUniformLocation(program, "uRes"),
    time: gl.getUniformLocation(program, "uTime"), energy: gl.getUniformLocation(program, "uEnergy") };
}

export default function PhosphorOrb({ active }: { active: boolean }) {
  const supported = useSyncExternalStore(noop, hasWebGL2, () => false);
  const [failed, setFailed] = useState(false);
  const reduceMotion = useReducedMotionConfig() ?? false;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const energyTarget = useRef(active ? 1 : 0);
  useEffect(() => { energyTarget.current = active ? 1 : 0; }, [active]);
  const mode = supported && !failed ? "webgl" : "fallback";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (mode !== "webgl" || !canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: true,
      powerPreference: "default" });
    let live = true;
    const fail = () => { void Promise.resolve().then(() => { if (live) setFailed(true); }); };
    if (!gl) { fail(); return () => { live = false; }; }
    const quality = deviceQuality();
    let scene = buildScene(gl, quality, canvas);
    if (!scene) { fail(); return () => { live = false; }; }

    let raf: number | null = null;
    let visible = true;
    let last = 0;
    let energy = energyTarget.current;
    const start = performance.now();

    const size = () => {
      const px = canvasPixels(canvas.clientWidth, quality.dpr);
      if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px; }
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const draw = (seconds: number) => {
      if (!scene || gl.isContextLost()) return;
      size();
      gl.uniform2f(scene.res, canvas.width, canvas.height);
      gl.uniform1f(scene.time, seconds);
      gl.uniform1f(scene.energy, energy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      canvas.dataset.ready = "true";
    };
    const frame = (now: number) => {
      raf = null;
      if (!live || !visible) return;
      if (now - last >= 1000 / quality.fps - 2) {
        energy += (energyTarget.current - energy) * 0.08;
        draw((now - start) / 1000);
        last = now;
      }
      raf = requestAnimationFrame(frame);
    };
    const run = () => {
      if (reduceMotion) { energy = energyTarget.current; draw(STILL_TIME); return; }
      if (raf === null && visible && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const stop = () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; };
    const onVisibility = () => { if (document.hidden) stop(); else run(); };
    const onLost = (event: Event) => { event.preventDefault(); stop(); scene = null; };
    const onRestored = () => { scene = buildScene(gl, quality, canvas); if (scene) run(); else fail(); };
    const intersection = typeof IntersectionObserver === "function"
      ? new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; if (visible) run(); else stop(); })
      : null;
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (reduceMotion) run(); }) : null;

    intersection?.observe(canvas);
    resize?.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    canvas.addEventListener("orb-still", run);
    run();

    return () => {
      live = false;
      stop();
      intersection?.disconnect();
      resize?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      canvas.removeEventListener("orb-still", run);
      if (scene && !gl.isContextLost()) {
        gl.deleteBuffer(scene.buffer);
        gl.deleteVertexArray(scene.vao);
        gl.deleteProgram(scene.program);
      }
      scene = null;
    };
  }, [mode, reduceMotion]);

  // Reduced motion draws one still frame, so a change of state repaints it at the new energy.
  useEffect(() => {
    if (reduceMotion && mode === "webgl") canvasRef.current?.dispatchEvent(new Event("orb-still"));
  }, [active, reduceMotion, mode]);

  return (
    <span aria-hidden="true" className={styles.orbArt} data-orb-mode={mode}>
      <span className={styles.orbGlow} />
      {mode === "webgl" && <canvas ref={canvasRef} className={styles.orbCanvas} />}
    </span>
  );
}
