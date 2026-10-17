"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotionConfig, useTransform } from "motion/react";
import Rainbow from "@/components/today/scene/Rainbow";
import PondWater, { type KeyRow, type PondApi } from "@/components/today/scene/PondWater";
import { BANDS, BOX, CLOUDS, KEY, LURE, SPRITE, bandShare, castFlight, linePath, rainbowHit, rodTip,
  type Band } from "@/components/today/scene/scene-geometry";
import { initialSulk, nextChange, poke, pose as poseOf, sulkLine, type Pose } from "@/components/today/scene/sulk";
import { MASCOTS, named, sceneArt } from "@/components/today/island/mascots";
import { useMascot } from "@/components/today/island/well-pet";
import { requestTiltPermission, useWaterTilt } from "@/components/today/useWaterTilt";
import { PEBBLE, SWIM_PATH, usePondMoments } from "@/components/today/scene/usePondMoments";
import { MOMENTS, type MomentKey, type MomentPose } from "@/components/today/scene/moments";
import { balance, type PanelData } from "@/components/today/LiveWidgetPanels";
import { MACRO_SPEC, formatMacro } from "@/components/nutrition/spec";
import { balanceBound, boundWords } from "@/lib/nutrition-display";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import type { PetState } from "@/lib/today/pet-mood";
import styles from "@/components/today/scene/PondScene.module.css";

type Sprite = Pose | "cast" | "catch" | "doze" | MomentPose;
type Catch = "fish" | "tip" | "token";
const SPRITES: Sprite[] = ["fishing", "cast", "catch", "sulk", "lookback", "annoyed", "doze", "rockthrow-windup",
  "rockthrow-release", "dance-1", "dance-2", "workout-lift", "workout-flex", "tummy-round", "tummy-suck", "stick-1", "stick-2"];
const CATCH_ART: Record<Catch, { src: string; label: string }> = {
  fish: { src: "/pet/scene/catch-fish.webp", label: "Sprout caught a little fish and lets it go." },
  tip: { src: "/pet/scene/catch-tip.webp", label: "Sprout fished up a note." },
  token: { src: "/pet/scene/catch-token.webp", label: "Sprout fished up a gold leaf: a goal reached today." },
};
/** Casts come every 28–44 s while the pond is shown; the first a moment after it opens. */
const nextCastIn = () => 28_000 + Math.random() * 16_000;
const pct = (v: number, of: number) => `${(v / of) * 100}%`;
const place = (x: number, y: number, w: number) => ({ left: pct(x, BOX.w), top: pct(y, BOX.h), width: pct(w, BOX.w) });

/** The key's four lines: what remains of each target, no "left" (the heading says it). */
function keyRows(data: PanelData, bands: readonly Band[]): KeyRow[] {
  return bands.map((band) => {
    const { amount, over } = balance(band, data);
    const bound = boundWords(balanceBound(data.partial, over));
    const unit = band === "kcal" ? "kcal" : `g ${MACRO_SPEC[band].abbr}`;
    const value = `${bound ? `${bound === "at most" ? "up to" : bound} ` : ""}${formatMacro(amount)}`;
    return { band, value: over ? `${value} over` : value, label: unit };
  });
}

/**
 * Sprout's pond (owner, 2026-10-07): the open well's scene in place of the rings. A petrol evening
 * sky over a lake, clouds drifting, the day's rainbow filling as meals go in, and Sprout big in the
 * foreground on a mossy rock, fishing. It casts every half minute or so; the lure lands centre right
 * and rings spread on the water. Now and then it catches a little fish; a meal logged earns a cheer
 * catch, a target reached a gold leaf. Tap the rainbow and its key appears on the water, "remaining";
 * tap again and it sinks away. A day behind never makes Sprout sulk (OD19); poke it a few times and it
 * turns away, looks back with tears, and too many pokes make it annoyed (sulk.ts). Layout: scene-geometry.ts.
 */
export default function PondScene({ data, pet, paused = false, cheer = 0, bands = BANDS, demo }: {
  data: PanelData; pet: PetState; paused?: boolean;
  /** Design gallery only: play this moment now and every few seconds, to review it. */
  demo?: MomentKey;
  /** The rainbow's bands, outside in: all four, or the three macros for a saved "Macro rings" view. */
  bands?: readonly Band[];
  /** Counts up when the day's log grows: Sprout lands a cheer catch. */
  cheer?: number;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const mascot = useMascot();
  const box = useRef<HTMLDivElement | null>(null);
  const water = useRef<PondApi | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  const animate_ = !reduce && onScreen && !paused;
  const tilt = useWaterTilt(animate_);
  const [keyOpen, setKeyOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [sulk, setSulk] = useState(initialSulk);
  const [action, setAction] = useState<"rest" | "cast" | "catch">("rest");
  const [caught, setCaught] = useState<Catch | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const lx = useMotionValue<number>(LURE.x);
  const ly = useMotionValue<number>(LURE.y);
  const slack = useMotionValue(1);

  const shares = useMemo(() => Object.fromEntries(BANDS.map((b) => [b, bandShare(data.consumed[b], data.targets[b])])) as
    Record<Band, number>, [data.consumed, data.targets]);
  const rows = useMemo(() => keyRows(data, bands), [data, bands]);
  const hit = useMemo(() => rainbowHit(bands.length), [bands.length]);
  const sleepy = pet.mood === "sleepy";
  const current = poseOf(sulk, now);
  // Sprout's own moments (moments.ts): only while it fishes calmly, the day is fine and nothing else runs.
  const moments = usePondMoments({ mascot, enabled: animate_ && current === "fishing" && action === "rest" && !caught && !sleepy && !keyOpen,
    splash: (x, y, strength) => water.current?.splash(x, y, strength) });
  const sprite: Sprite = current !== "fishing" ? current : moments.pose ?? (action === "cast" ? "cast"
    : action === "catch" ? "catch" : sleepy ? "doze" : "fishing");
  const playMoment = moments.play;
  useEffect(() => {
    if (!demo || !animate_) return;
    const first = setTimeout(() => playMoment(demo), 1200);
    const again = setInterval(() => playMoment(demo), 8000);
    return () => { clearTimeout(first); clearInterval(again); };
  }, [demo, animate_, playMoment]);
  const spinning = !reduce && moments.key !== null && MOMENTS[moments.key].spin === true;
  const holdsRod = !moments.key && (sprite === "fishing" || sprite === "cast" || sprite === "catch" || sprite === "doze");
  const tip = rodTip(sprite === "cast" ? "cast" : sprite === "catch" ? "catch" : "fishing");
  const line = useTransform([lx, ly, slack], ([x, y, s]) => linePath(tip, { x: x as number, y: y as number }, s as number));

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A new mood (awake, asleep) drops a reply to an earlier tap.
  useEffect(() => {
    setNow(Date.now());
    setSaid(null);
  }, [pet.mood]);
  // Wake for the next timed change of pose (a look-back ending, annoyance passing); rests while paused.
  useEffect(() => {
    const at = nextChange(sulk, now);
    if (at === null || paused) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [sulk, now, paused]);
  // A greeting is a moment, not a new mood line.
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), 2400);
    return () => clearTimeout(timer);
  }, [said]);

  // Every cast and catch belongs to one run; pausing, closing or a newer action ends the old run and
  // stops its animations, so nothing lands, sets state or moves the lure afterwards.
  const run = useRef(0);
  const motions = useRef<{ stop: () => void }[]>([]);
  const halt = useCallback(() => {
    run.current += 1;
    for (const m of motions.current) m.stop();
    motions.current = [];
  }, []);
  const track = useCallback(<T extends { stop: () => void }>(m: T): T => { motions.current.push(m); return m; }, []);
  useEffect(() => () => halt(), [halt]);
  // Paused, or night falling: any cast or catch in flight ends and the lure rests on the water.
  useEffect(() => {
    if (animate_ && !sleepy) return;
    halt(); setAction("rest"); setCaught(null); lx.set(LURE.x); ly.set(LURE.y); slack.set(1);
  }, [animate_, sleepy, halt, lx, ly, slack]);

  const cast = useCallback(async () => {
    if (!animate_) return;
    halt();
    const mine = run.current;
    const alive = () => mine === run.current;
    setAction("cast");
    const wind = rodTip("cast");
    await Promise.all([track(animate(lx, wind.x, SPRINGS.snappy)), track(animate(ly, wind.y, SPRINGS.snappy))]);
    if (!alive()) return;
    setAction("rest");
    const from = rodTip("fishing");
    await track(animate(0, 1, { ...SPRINGS.smooth, onUpdate: (p: number) => {
      const at = castFlight(from, LURE, p);
      lx.set(at.x); ly.set(at.y);
    } }));
    if (!alive()) return;
    lx.set(LURE.x); ly.set(LURE.y);
    slack.set(1.8);
    water.current?.splash(LURE.x, LURE.y, 70);
    track(animate(slack, 1, SPRINGS.gentle));
  }, [animate_, halt, track, lx, ly, slack]);

  const land = useCallback(async (what: Catch) => {
    // At night Sprout dozes: nothing is caught until morning.
    if (sleepy) return;
    if (!animate_) { setCaught(what); return; }
    halt();
    const mine = run.current;
    setAction("catch");
    const up = rodTip("catch");
    water.current?.splash(LURE.x, LURE.y, 90);
    await Promise.all([track(animate(lx, up.x, SPRINGS.bouncy)), track(animate(ly, up.y + 18, SPRINGS.bouncy))]);
    if (mine === run.current) setCaught(what);
  }, [animate_, sleepy, halt, track, lx, ly]);

  // The cast cycle, while fishing and shown.
  useEffect(() => {
    if (!animate_ || !holdsRod || sleepy) return;
    let timer = setTimeout(function next() { void cast(); timer = setTimeout(next, nextCastIn()); }, 2500);
    return () => clearTimeout(timer);
  }, [animate_, holdsRod, sleepy, cast]);
  // Now and then, a fish (at most one every 90 s, one in four).
  useEffect(() => {
    if (!animate_ || !holdsRod || sleepy) return;
    const timer = setInterval(() => { if (Math.random() < 0.25) void land("fish"); }, 90_000);
    return () => clearInterval(timer);
  }, [animate_, holdsRod, sleepy, land]);
  // The day's log grew: a cheer catch. A target newly reached: a gold leaf.
  const lastCheer = useRef(cheer);
  const full = bands.filter((b) => shares[b] >= 1).length;
  const lastFull = useRef(full);
  useEffect(() => {
    const grew = cheer > lastCheer.current;
    const reached = full > lastFull.current;
    lastCheer.current = cheer;
    lastFull.current = full;
    if (reached) void land("token");
    else if (grew) void land("fish");
  }, [cheer, full, land]);
  // A catch shows for a moment, then the fish goes back and the line is cast again.
  useEffect(() => {
    if (!caught) return;
    const timer = setTimeout(() => { setCaught(null); setAction("rest"); void cast(); }, caught === "fish" ? 2200 : 3600);
    return () => clearTimeout(timer);
  }, [caught, cast]);

  const lastPoke = useRef(0);
  function onPoke() {
    requestTiltPermission();
    const at = Date.now();
    // A double tap while Sprout fishes calmly: the tummy gag, only ever when asked for (moments.ts).
    const double = at - lastPoke.current < 350 && current === "fishing";
    lastPoke.current = at;
    // Asked for, so it is said aloud too (the automatic moments stay quiet).
    if (double && moments.play("tummy")) { setSaid(MOMENTS.tummy.line); return; }
    const result = poke(sulk, at);
    setSulk(result.state);
    setNow(at);
    if (result.reaction === "greet") setSaid("Sprout waves without letting go of the rod.");
    else setSaid(null);
  }
  // What a screen reader hears: the mood, a sulk or a reply to the person's own tap. Sprout's
  // automatic moments only change the visible caption, so they never interrupt.
  const spoken = named(sulkLine(sulk, now) ?? said ?? pet.line, mascot);
  const shownLine = named(sulkLine(sulk, now) ?? said ?? moments.line ?? pet.line, mascot);
  // Only the pose on show and the one fading out are mounted; the rest load when needed.
  const [mounted, setMounted] = useState<Sprite[]>([sprite]);
  useEffect(() => {
    setMounted((m) => (m[m.length - 1] === sprite ? m : [m[m.length - 1], sprite]));
  }, [sprite]);

  return <div ref={box} className={styles.scene} data-night={sleepy || undefined} data-still={!animate_ || undefined}
    onPointerDown={requestTiltPermission}>
    <Image src="/pet/scene/pond-sky.webp" alt="" fill sizes="420px" priority={false}
      className={styles.backdrop} draggable={false} />
    <Rainbow shares={shares} bands={bands} />
    {CLOUDS.map((cloud) => <span key={cloud.src} aria-hidden="true" className={styles.cloud}
      data-still={!animate_ || undefined} style={{ ...place(cloud.x, cloud.y, cloud.w),
        ["--drift" as string]: `${cloud.drift}px`, ["--period" as string]: `${cloud.period}s` }}>
      <Image src={cloud.src} alt="" width={180} height={124} sizes="90px" draggable={false} />
    </span>)}
    <PondWater shares={shares} bands={bands} keyRows={keyOpen ? rows : null} animate={animate_} tilt={tilt} controlRef={water} />
    <button type="button" className={`tap ${styles.rainbowHit}`} aria-expanded={keyOpen}
      aria-label={keyOpen ? "Hide what remains" : "Show what remains today"}
      style={{ left: pct(hit.left, BOX.w), top: pct(hit.top, BOX.h), width: pct(hit.w, BOX.w), height: pct(hit.h, BOX.h),
        clipPath: hit.clip }}
      onClick={(event) => { event.stopPropagation(); setKeyOpen((open) => !open); }} />
    <span aria-hidden="true" className={styles.sprite} style={place(SPRITE.x, SPRITE.y, SPRITE.w)}>
      <Image src="/pet/scene/rock.webp" alt="" fill sizes="330px" className={styles.art} draggable={false} />
      {SPRITES.filter((name) => name === sprite || mounted.includes(name)).map((name) => {
        // A spin turns the pose on the spot twice with a little hop; the rock stays put.
        const turning = spinning && name === sprite;
        return <motion.span key={name} className={styles.pose} data-on={(name === sprite && !moments.swimming) || undefined}
          style={{ transformOrigin: "44% 72%" }}
          animate={turning ? { scaleX: [1, -1, 1, -1, 1], y: ["0%", "-3%", "0%", "-3%", "0%"] } : { scaleX: 1, y: "0%" }}
          transition={turning ? { duration: 1.5, ease: "easeInOut" } : INSTANT}>
          <Image src={sceneArt(mascot, name)} alt="" fill sizes="330px" className={styles.art} draggable={false} />
        </motion.span>;
      })}
      {sprite === "lookback" && !reduce && <span className={styles.tears}>
        <span className={styles.tear} /><span className={styles.tear} />
      </span>}
    </span>
    <svg aria-hidden="true" className={`${styles.layer} ${styles.tackle}`} viewBox="0 0 350 420">
      <AnimatePresence>
        {holdsRod && <motion.g key="tackle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={reduce ? INSTANT : FADES.base}>
          <motion.path d={line} className={styles.line} fill="none" />
          <motion.circle cx={lx} cy={ly} r={2.6} className={styles.lure} />
        </motion.g>}
      </AnimatePresence>
    </svg>
    <AnimatePresence>
      {moments.key === "pebble" && moments.frame === 1 && !reduce && <motion.span key="pebble" aria-hidden="true"
        className={styles.pebble} initial={{ left: pct(PEBBLE.from.x, BOX.w), top: pct(PEBBLE.from.y, BOX.h), scale: 1 }}
        animate={{ left: [pct(PEBBLE.from.x, BOX.w), pct((PEBBLE.from.x + PEBBLE.to.x) / 2 + 20, BOX.w), pct(PEBBLE.to.x, BOX.w)],
          top: [pct(PEBBLE.from.y, BOX.h), pct(PEBBLE.from.y - 60, BOX.h), pct(PEBBLE.to.y, BOX.h)], scale: [1, 0.9, 0.6] }}
        exit={{ opacity: 0 }} transition={{ duration: 0.52, ease: "easeIn" }} />}
      {moments.swimming && <motion.span key="swim" aria-hidden="true" className={styles.swim}
        initial={{ opacity: 0, left: pct(SWIM_PATH[0].x, BOX.w), top: pct(SWIM_PATH[0].y, BOX.h), scaleX: 1 }}
        animate={reduce ? { opacity: 1 } : { opacity: [0, 1, 1, 1, 0], left: SWIM_PATH.map((p) => pct(p.x, BOX.w)),
          top: SWIM_PATH.map((p) => pct(p.y, BOX.h)), scaleX: [1, 1, -1], y: [0, -3, 0, -3, 0] }}
        exit={{ opacity: 0 }} transition={{ duration: 4.6, ease: "easeInOut" }}>
        <Image src={sceneArt(mascot, "swim")} alt="" width={180} height={154} sizes="90px" draggable={false} />
      </motion.span>}
    </AnimatePresence>
    <button type="button" className={`tap ${styles.pokeHit}`} aria-label={`${MASCOTS[mascot].name}. Poke`}
      style={{ ...place(26, 112, 140), height: pct(208, BOX.h) }}
      onClick={(event) => { event.stopPropagation(); onPoke(); }} />
    <AnimatePresence>
      {caught && <motion.span key={caught} className={styles.catch} role="img" aria-label={named(CATCH_ART[caught].label, mascot)}
        style={place(rodTip("catch").x - 26, rodTip("catch").y + 10, 52)}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4, y: 30, rotate: -20 }}
        animate={{ opacity: 1, scale: 1, y: 0, rotate: [0, 12, -8, 0] }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 60 }} transition={reduce ? INSTANT : SPRINGS.bouncy}>
        <Image src={CATCH_ART[caught].src} alt="" width={104} height={104} sizes="52px" draggable={false} />
      </motion.span>}
    </AnimatePresence>
    <AnimatePresence>
      {keyOpen && <motion.div key="key" role="group" aria-label="Remaining today" className={`matte ${styles.key}`}
        style={place(KEY.x, KEY.y, KEY.w)}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: "blur(4px)" }} transition={reduce ? INSTANT : SPRINGS.smooth}>
        <span className={styles.keyTitle}>remaining</span>
        {rows.map((row) => <span key={row.band} className={styles.keyRow} data-band={row.band}>
          <span aria-hidden="true" className={styles.keyDot} />
          <span className={styles.keyValue}>{row.value}</span>
          <span className={styles.keyLabel}>{row.label}</span>
        </span>)}
      </motion.div>}
    </AnimatePresence>
    <p className={styles.caption} aria-hidden="true">{shownLine}</p>
    <p className="sr-only" aria-live="polite">{spoken}</p>
  </div>;
}
