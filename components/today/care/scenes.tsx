"use client";

import Image from "next/image";
import { useEffect, useState, type RefObject } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { MATERIAL_ART, type Award } from "@/components/today/care/awards";
import type { SparksApi } from "@/components/today/care/Sparks";
import type { Cue } from "@/components/today/care/sound";
import { EASE_OUT, SPRINGS } from "@/lib/design/motion";
import styles from "@/components/today/care/Awards.module.css";
import { sceneArt } from "@/components/today/island/mascots";
import { useMascot } from "@/components/today/island/well-pet";

export type SceneProps = {
  award: Award;
  sparks: RefObject<SparksApi | null>;
  cue: (cue: Cue) => void;
  /** Skip or reduced motion: draw the finished moment at once. */
  final: boolean;
  onDone: () => void;
};

const W = 350;
const H = 420;
const CX = 175;
const CY = 190;
type Stoppable = { stop: () => void };
const usePctX = (v: MotionValue<number>) => useTransform(v, (n) => `${(n / W) * 100}%`);
const usePctY = (v: MotionValue<number>) => useTransform(v, (n) => `${(n / H) * 100}%`);
type Kit = {
  /** Track an animation so leaving the scene stops it. */
  t: <T extends Stoppable>(m: T) => T;
  alive: () => boolean;
  /** A pause that leaving the scene cancels (it then answers false). */
  wait: (ms: number) => Promise<boolean>;
  /** One animation frame that leaving the scene cancels (calling `onCancel`, so a waiting step settles). */
  frame: (step: (now: number) => void, onCancel?: () => void) => void;
};

/**
 * Runs one scene's script per mount, a tick after mounting (so a development double mount never plays
 * the first, cancelled run), with every animation, pause and frame stopped and every pending step
 * settled when the scene goes away (skip, replay, close).
 */
function useScript(final: boolean, onDone: () => void, script: (kit: Kit) => Promise<void>) {
  useEffect(() => {
    if (final) { onDone(); return; }
    let live = true;
    const stops: Stoppable[] = [];
    const timers = new Map<ReturnType<typeof setTimeout>, (ok: boolean) => void>();
    const frames = new Map<number, (() => void) | undefined>();
    const kit: Kit = {
      t: (m) => { stops.push(m); return m; },
      alive: () => live,
      wait: (ms) => new Promise<boolean>((resolve) => {
        const id = setTimeout(() => { timers.delete(id); resolve(live); }, ms);
        timers.set(id, resolve);
      }),
      frame: (step, onCancel) => {
        const id = requestAnimationFrame((now) => { frames.delete(id); if (live) step(now); });
        frames.set(id, onCancel);
      },
    };
    const start = setTimeout(() => { void script(kit).then(() => { if (live) onDone(); }); }, 0);
    return () => {
      live = false;
      clearTimeout(start);
      for (const s of stops) s.stop();
      for (const [id, resolve] of timers) { clearTimeout(id); resolve(false); }
      for (const [id, onCancel] of frames) { cancelAnimationFrame(id); onCancel?.(); }
    };
    // The script runs once per mount; a replay remounts the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function Lock({ count }: { count: number }) {
  return <AnimatePresence>
    {count > 0 && <motion.span key={count} aria-hidden="true" className={styles.ring}
      initial={{ opacity: 1, scale: 0.6 }} animate={{ opacity: 0, scale: 2.2 }} transition={{ duration: 0.7, ease: EASE_OUT }} />}
    {count > 0 && <motion.span key={`f${count}`} aria-hidden="true" className={styles.flash}
      initial={{ opacity: 0.7 }} animate={{ opacity: 0 }} transition={{ duration: 0.5, ease: EASE_OUT }} />}
  </AnimatePresence>;
}

/**
 * A material token: it rises from below, spins up to the middle, bounces off the card's walls throwing
 * sparks at every hit, then settles, swells and locks with its sound and a ring of light.
 */
export function TokenScene({ award, sparks, cue, final, onDone }: SceneProps) {
  const x = useMotionValue(CX);
  const y = useMotionValue(final ? CY : H + 60);
  const spin = useMotionValue(0);
  const scale = useMotionValue(final ? 1 : 0.4);
  const left = usePctX(x);
  const top = usePctY(y);
  const [lock, setLock] = useState(0);
  useScript(final, onDone, async ({ t, alive, frame }) => {
    cue("whoosh");
    await Promise.all([t(animate(y, 330, { duration: 0.3, ease: EASE_OUT })), t(animate(scale, 0.7, { duration: 0.3 }))]);
    if (!alive()) return;
    await Promise.all([t(animate(y, CY, SPRINGS.smooth)), t(animate(spin, 720, { duration: 0.8, ease: EASE_OUT })),
      t(animate(scale, 1, SPRINGS.bouncy))]);
    if (!alive()) return;
    // Off the walls: a few elastic hits, sparks at each, slowing as it goes.
    await new Promise<void>((resolve) => {
      const R = 52;
      let vx = (Math.random() < 0.5 ? -1 : 1) * 440;
      let vy = -340;
      let last = performance.now();
      const start = last;
      const step = (now: number) => {
        if (!alive()) return resolve();
        const dt = Math.min(0.033, (now - last) / 1000);
        last = now;
        let nx = x.get() + vx * dt;
        let ny = y.get() + vy * dt;
        if (nx < R || nx > W - R) { vx = -vx * 0.88; nx = Math.max(R, Math.min(W - R, nx)); sparks.current?.burst(nx < CX ? 6 : W - 6, ny, 9); }
        if (ny < R || ny > 290) { vy = -vy * 0.88; ny = Math.max(R, Math.min(290, ny)); sparks.current?.burst(nx, ny < CY ? 6 : 300, 9); }
        x.set(nx); y.set(ny); spin.set(spin.get() + vx * dt * 1.4);
        if (now - start > 1700) return resolve();
        frame(step, resolve);
      };
      frame(step, resolve);
    });
    if (!alive()) return;
    await Promise.all([t(animate(x, CX, SPRINGS.bouncy)), t(animate(y, CY, SPRINGS.bouncy)),
      t(animate(spin, Math.round(spin.get() / 360) * 360, SPRINGS.smooth))]);
    if (!alive()) return;
    cue(award.cue);
    sparks.current?.burst(CX, CY, 18);
    setLock((n) => n + 1);
    await t(animate(scale, [1.25, 1], { duration: 0.45, ease: EASE_OUT }));
  });
  return <>
    <Lock count={lock} />
    <motion.span aria-hidden="true" className={styles.token} style={{ left, top, scale, rotateY: spin, transformPerspective: 600 }}>
      <Image src={MATERIAL_ART[award.material]} alt="" width={256} height={256} sizes="120px" draggable={false} />
    </motion.span>
  </>;
}

/**
 * The workout award (owner, 2026-10-07): a buff little Sprout pumps two dumbbells, then flexes so hard
 * its face goes red, bursts into flame, and boom: a steel badge flies off the wall and locks in, shink.
 * Sprout comes out of it unharmed and still flexing.
 */
export function FlexScene({ award, sparks, cue, final, onDone }: SceneProps) {
  const mascot = useMascot();
  const [pose, setPose] = useState<"lift" | "flex">(final ? "flex" : "lift");
  const rise = useMotionValue(final ? 0 : 260);
  const shake = useMotionValue(0);
  const heat = useMotionValue(final ? 0.35 : 0);
  const bx = useMotionValue(final ? CX : -60);
  const by = useMotionValue(final ? 70 : 120);
  const bScale = useMotionValue(final ? 1 : 0.6);
  const left = usePctX(bx);
  const top = usePctY(by);
  const [lock, setLock] = useState(0);
  useScript(final, onDone, async ({ t, alive, wait }) => {
    await t(animate(rise, 0, SPRINGS.bouncy));
    if (!(await wait(250))) return;
    for (let i = 0; i < 2; i += 1) {
      await t(animate(rise, [0, 8, 0], { duration: 0.28, ease: "easeInOut" }));
      if (!alive()) return;
    }
    setPose("flex");
    cue("whoosh");
    void t(animate(heat, [0, 1, 0.7, 1], { duration: 0.6 }));
    await t(animate(shake, [0, -3, 3, -4, 4, -3, 3, 0], { duration: 0.55 }));
    if (!alive()) return;
    sparks.current?.fire(105, 120, 140, 190, 0.6);
    if (!(await wait(550))) return;
    cue("boom");
    sparks.current?.burst(CX, 200, 18);
    setLock((n) => n + 1);
    void t(animate(heat, 0.35, { duration: 0.6 }));
    await t(animate(bx, W - 40, { duration: 0.35, ease: EASE_OUT }));
    if (!alive()) return;
    sparks.current?.burst(W - 8, 120, 9);
    await Promise.all([t(animate(bx, CX, SPRINGS.bouncy)), t(animate(by, 70, SPRINGS.bouncy)), t(animate(bScale, 1, SPRINGS.bouncy))]);
    if (!alive()) return;
    cue(award.cue);
    sparks.current?.burst(CX, 70, 14);
  });
  return <>
    <motion.span aria-hidden="true" className={styles.heat} style={{ opacity: heat }} />
    <Lock count={lock} />
    <motion.span aria-hidden="true" className={styles.sprout} style={{ y: rise, x: shake }}>
      <Image src={sceneArt(mascot, `award-workout-${pose}`)} alt="" width={420} height={420} sizes="200px" draggable={false} />
    </motion.span>
    <motion.span aria-hidden="true" className={styles.badge} style={{ left, top, scale: bScale }}>
      <Image src={MATERIAL_ART[award.material]} alt="" width={256} height={256} sizes="90px" draggable={false} />
    </motion.span>
  </>;
}

const SPEECH = "Just hanging out to celebrate you.";

/**
 * The night award (owner, 2026-10-07): pitch black, a crescent moon barely lighting the sky, one street
 * lamp over a single bench. Two eyes blink in the dark at the lower right, vanish, blink again high in
 * the sky; then a little bat walks into the lamplight, opens its wings and says its line, and a
 * wooden badge drops into the light. Plays any time; it never rewards staying up.
 */
export function BatScene({ award, sparks, cue, final, onDone }: SceneProps) {
  const [eyes, setEyes] = useState<"none" | "low" | "sky">("none");
  const [revealed, setRevealed] = useState(final);
  const night = useMotionValue(final ? 1 : 0);
  const blink = useMotionValue(1);
  const batX = useMotionValue(final ? 168 : W + 50);
  const bob = useMotionValue(0);
  const bx = useMotionValue(final ? 250 : 250);
  const by = useMotionValue(final ? 250 : -60);
  const left = usePctX(batX);
  const bLeft = usePctX(bx);
  const bTop = usePctY(by);
  const [lock, setLock] = useState(0);
  useScript(final, onDone, async ({ t, alive, wait }) => {
    await t(animate(night, 1, { duration: 0.55, ease: EASE_OUT }));
    for (const spot of ["low", "sky"] as const) {
      setEyes(spot);
      for (let i = 0; i < 2; i += 1) {
        if (!(await wait(200))) return;
        await t(animate(blink, [1, 0.1, 1], { duration: 0.18 }));
      }
      setEyes("none");
      if (!(await wait(250))) return;
    }
    void t(animate(bob, [0, -4, 0, -4, 0, -4, 0], { duration: 1.1, ease: "easeInOut" }));
    await t(animate(batX, 168, { duration: 1.1, ease: EASE_OUT }));
    if (!alive()) return;
    setRevealed(true);
    cue("whoosh");
    if (!(await wait(550))) return;
    await t(animate(by, 250, SPRINGS.bouncy));
    if (!alive()) return;
    cue(award.cue);
    sparks.current?.burst(250, 250, 14);
    setLock((n) => n + 1);
  });
  const eyeAt = eyes === "low" ? { left: "82%", top: "80%" } : { left: "71%", top: "26%" };
  return <>
    <motion.div className={styles.night} style={{ opacity: night }}>
      <Image src="/pet/night/bench.webp" alt="" fill sizes="420px" draggable={false} />
    </motion.div>
    {eyes !== "none" && <motion.span aria-hidden="true" className={styles.eyes} style={{ ...eyeAt, scaleY: blink }}>
      <span className={styles.eye} /><span className={styles.eye} />
    </motion.span>}
    <motion.span aria-hidden="true" className={styles.bat} style={{ left, top: "73%", y: bob }}>
      <Image src={revealed ? "/pet/night/bat-reveal.webp" : "/pet/night/bat-walk.webp"} alt="" width={300} height={240}
        sizes="80px" draggable={false} />
    </motion.span>
    <AnimatePresence>
      {revealed && <motion.p className={styles.speech} style={{ left: "52%", top: "54%" }}
        initial={final ? false : { opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
        transition={final ? { duration: 0 } : SPRINGS.bouncy}>
        {SPEECH}
      </motion.p>}
    </AnimatePresence>
    <Lock count={lock} />
    <motion.span aria-hidden="true" className={styles.badge} style={{ left: bLeft, top: bTop }}>
      <Image src={MATERIAL_ART[award.material]} alt="" width={256} height={256} sizes="90px" draggable={false} />
    </motion.span>
  </>;
}
