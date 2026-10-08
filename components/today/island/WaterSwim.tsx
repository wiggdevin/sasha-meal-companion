"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { play, readMuted } from "@/components/today/care/sound";
import styles from "@/components/today/island/WellWater.module.css";
import { MASCOTS, named, sceneArt } from "@/components/today/island/mascots";
import { useMascot } from "@/components/today/island/well-pet";

/** Where the glass breaks: across the basin, and how far down into the water body below the surface. */
export const IMPACT = { x: 0.3, below: 0.3 } as const;
/** The swim, ms: the crack, Sprout through it and into the water, across, and the glass mending. */
export const POP_MS = 160;
const SPLASH_MS = 520;
const SWIM_MS = 3700;
const MEND_MS = 2900;
const DONE_MS = 4300;

/** The crack's lines from the point of impact (a 100-unit box): fixed, so every break looks alike. */
const CRACKS = [8, 52, 101, 150, 197, 243, 290, 335].map((deg, i) => {
  const a = (deg * Math.PI) / 180;
  const len = 30 + ((i * 7) % 18);
  const bend = (i % 2 ? 1 : -1) * 0.22;
  const p = (t: number, turn: number) => `${(50 + Math.cos(a + turn) * len * t).toFixed(1)} ${(50 + Math.sin(a + turn) * len * t).toFixed(1)}`;
  return `M50 50 L${p(0.35, bend)} L${p(0.7, -bend * 0.6)} L${p(1, bend * 0.4)}`;
});
const RINGS = ["M41 46 Q50 39 59 45", "M56 58 Q47 63 40 56", "M33 40 Q44 27 62 33"];
const SHARDS = [[-1, -0.6, 40], [0.9, -0.8, -30], [1, 0.4, 70], [-0.8, 0.7, -60], [0.2, -1, 20], [-0.3, 1, 90]] as const;

/**
 * Sprout breaks through the glass for a swim (owner, 2026-10-06: "breaking through the glass to swim").
 * Each swim (a double tap on the water, the keyboard's own button, or now and then on its own) cracks the well's front glass at
 * a point in the water with a little clack, sends a few shards toward the viewer, and Sprout pops in
 * through the crack, splashes (`onSplash` moves the real surface) and swims across at depth; then the
 * glass mends. Decorative, with one polite line for a screen reader; nothing plays with motion reduced,
 * and the clack follows the shared Sound off.
 */
export default function WaterSwim({ run: asked, active, auto, surface, onSplash }: {
  /** Counts up once per swim the person asks for (a double tap in the water). */
  run: number;
  /** The water is moving (on screen, not paused, motion allowed): a swim stops at once when it is not. */
  active: boolean;
  /** Swim now and then on its own (every 100-160 s, while active): there is enough water to swim in. */
  auto: boolean;
  /** The water's surface, as a fraction of the basin's height from the top. */
  surface: number;
  /** Splash the real water at a fraction across the basin. */
  onSplash: (x: number, strength: number) => void;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const mascot = useMascot();
  // Read when the swim line is said, a beat after the swim starts.
  const mascotRef = useRef(mascot);
  useEffect(() => { mascotRef.current = mascot; }, [mascot]);
  const live = active && !reduce;
  const [phase, setPhase] = useState<"none" | "crack" | "mend">("none");
  const [said, setSaid] = useState("");
  const splashRef = useRef(onSplash);
  useEffect(() => { splashRef.current = onSplash; }, [onSplash]);
  const [own, setOwn] = useState(0);
  const [keyed, setKeyed] = useState(0);
  useEffect(() => {
    if (!live || !auto) return;
    const wait = () => 100_000 + Math.random() * 60_000;
    let timer = setTimeout(function again() { setOwn((n) => n + 1); timer = setTimeout(again, wait()); }, wait());
    return () => clearTimeout(timer);
  }, [live, auto]);
  const run = asked + own + keyed;
  // The last swim started: a pause never replays one when the water moves again.
  const started = useRef(0);

  useEffect(() => {
    // Paused, hidden or reduced: the swim (and its line) leaves at once; the cleanup stopped its timers.
    if (!live) { started.current = run; setPhase("none"); setSaid(""); return; }
    if (run <= started.current) return;
    started.current = run;
    setPhase("crack");
    // Cleared first, then said a beat later (when Sprout is actually through): a swim asked for again
    // before the last one's line faded would otherwise set the same string, which a screen reader
    // never notices as a change.
    setSaid("");
    if (!readMuted()) play("clack");
    const timers = [
      setTimeout(() => setSaid(named("Sprout breaks through the glass for a swim.", mascotRef.current)), POP_MS),
      setTimeout(() => splashRef.current(IMPACT.x, 110), SPLASH_MS),
      ...[0.35, 0.6, 0.85].map((u, i) => setTimeout(() => splashRef.current(IMPACT.x + (0.88 - IMPACT.x) * u, 28),
        SPLASH_MS + (SWIM_MS - SPLASH_MS) * u * (0.9 + i * 0.02))),
      setTimeout(() => setPhase("mend"), MEND_MS),
      setTimeout(() => { setPhase("none"); setSaid(""); }, DONE_MS),
    ];
    return () => { for (const id of timers) clearTimeout(id); };
  }, [run, live]);

  const y = surface + (1 - surface) * IMPACT.below;
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return <>
    {/* Only while live: when the water stops, the crack and Sprout leave at once, with no exit to play. */}
    <span aria-hidden="true" className={styles.swimLayer}>
      {live && <AnimatePresence>
        {phase !== "none" && <motion.svg key={`crack-${run}`} className={styles.crack} viewBox="0 0 100 100"
          style={{ left: pct(IMPACT.x), top: pct(y) }}
          initial={{ opacity: 1 }} animate={{ opacity: phase === "mend" ? 0 : 1 }} exit={{ opacity: 0 }}
          transition={{ duration: phase === "mend" ? 1.2 : 0.1 }}>
          {[...CRACKS, ...RINGS].map((d, i) => <motion.path key={i} d={d} className={styles.crackLine}
            initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.16, delay: i < CRACKS.length ? 0 : 0.08 }} />)}
          {SHARDS.map(([dx, dy, turn], i) => <motion.path key={`s${i}`} d="M50 47 L53 52 L48 53 Z" className={styles.shard}
            initial={{ x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 }}
            animate={{ x: dx * 46, y: dy * 46, rotate: turn, scale: 2.2, opacity: 0 }} transition={{ duration: 0.6, ease: "easeOut" }} />)}
        </motion.svg>}
      </AnimatePresence>}
      {live && <AnimatePresence>
        {phase !== "none" && <motion.span key={`swim-${run}`} className={styles.swimmer}
          initial={{ left: pct(IMPACT.x - 0.13), top: pct(y - 0.14), scale: 1.6, opacity: 0 }}
          animate={{ left: [IMPACT.x - 0.13, IMPACT.x - 0.1, 0.5, 0.78, 0.9].map(pct),
            top: [y - 0.14, y - 0.1, y - 0.06, y - 0.09, y - 0.05].map(pct),
            scale: [1.6, 0.62, 0.55, 0.52, 0.4], opacity: [0, 1, 1, 1, 0], rotate: [-18, 6, -4, 5, 0] }}
          transition={{ duration: (SWIM_MS - POP_MS) / 1000, delay: POP_MS / 1000, times: [0, 0.12, 0.45, 0.8, 1], ease: "easeInOut" }}>
          <Image src={sceneArt(mascot, "swim")} alt="" width={180} height={154} sizes="120px" draggable={false} />
        </motion.span>}
      </AnimatePresence>}
    </span>
    <span className="sr-only" aria-live="polite">{said}</span>
    {/* The keyboard's way to ask: hidden until it has focus, so touch sees no new chrome. */}
    {live && <button type="button" className={`tap ${styles.swimAsk}`}
      onClick={(event) => { event.stopPropagation(); setKeyed((n) => n + 1); }}>{MASCOTS[mascot].name}, take a swim</button>}
  </>;
}
