"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import Image from "next/image";
import {
  AnimatePresence, LayoutGroup, animate, motion, useIsPresent, useMotionValue, useReducedMotionConfig, useTransform,
  type MotionValue,
} from "motion/react";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import {
  BOARD_MORPH, MORPH_SETTLE_MS, TILES_COVERED, TILES_SHOWN, boardMorph, boxWithin, unhide, type Box,
} from "@/components/today/useDayCardMotion";
import styles from "@/components/today/DayBoard.module.css";

/**
 * An explainer on the Day card's board (2026-10-01). Either a real video (`src`, with its poster),
 * or a storyboard: a few captioned scenes drawn in the app's own shapes, played like a short clip
 * with a progress bar, pause and replay. The nutritionist's videos join the board as `src`
 * explainers; until then the board explains itself.
 */
export type Explainer = {
  id: string;
  title: string;
  /** Shown under the title, for example "0:20". */
  length: string;
  src?: string;
  poster?: string;
  scenes?: ExplainerScene[];
};

export type ExplainerScene = { kind: "week" | "month" | "orbit" | "board"; caption: string };

/** How long each storyboard scene plays, in seconds. */
const SCENE_SECONDS = 5;

export const DAY_CARD_EXPLAINER: Explainer = {
  id: "day-card",
  title: "How your Day card works",
  length: "0:20",
  scenes: [
    { kind: "week", caption: "Slide the week to choose a day. The olive lens marks it." },
    { kind: "month", caption: "Double-tap the week to see the next four weeks." },
    { kind: "orbit", caption: "Tap the eye to see your whole day on one ring." },
    { kind: "board", caption: "The board keeps your next step, water, tips and your week together." },
  ],
};

const ORBIT = [0, 1, 2, 3, 4, 5, 6].map((i) => {
  const a = (i * 2 * Math.PI) / 7;
  return { x: Math.round(62 * Math.sin(a)), y: Math.round(-62 * Math.cos(a)) };
});
const MARK = ["var(--color-gauge-calories)", "var(--color-gauge-carbs)", "var(--color-gauge-protein)",
  "var(--color-gauge-fat)", "var(--color-gauge-water)", "var(--color-alert)", "var(--color-gauge-protein-end)"];

/** One storyboard scene, drawn in the card's own shapes. `t` runs 0 → 1 across the scene. */
function Scene({ kind, t, reduce }: { kind: ExplainerScene["kind"]; t: MotionValue<number>; reduce: boolean }) {
  const slide = useTransform(t, [0, 0.3, 0.45, 0.7, 0.85, 1], [0, 0, -36, -36, -72, -72]);
  const grow = useTransform(t, [0, 0.3, 0.55, 1], [26, 26, 122, 122]);
  const launch = useTransform(t, [0, 0.2, 0.55, 1], [0, 0, 1, 1]);
  const tap = useTransform(t, [0.08, 0.16, 0.24], [0, 1, 0]);
  if (kind === "week") return <div className={styles.sceneWeek}>
    <span className={`day-lens ${styles.sceneLens}`} />
    <motion.div className={styles.sceneDays} style={{ x: reduce ? 0 : slide }}>
      {Array.from({ length: 11 }, (_, i) => <span key={i} className={styles.sceneDay}>
        <span className={styles.sceneDot} style={{ opacity: i % 3 === 0 ? 1 : 0.4 }} />
      </span>)}
    </motion.div>
  </div>;
  if (kind === "month") return <div className={styles.sceneMonth}>
    <motion.div className={styles.sceneSheet} style={{ height: reduce ? 122 : grow }}>
      {Array.from({ length: 35 }, (_, i) => <span key={i} className={styles.sceneCell} data-on={i === 3 || undefined} />)}
    </motion.div>
    {!reduce && <motion.span className={styles.sceneTap} style={{ opacity: tap, scale: tap }} />}
  </div>;
  if (kind === "orbit") return <div className={styles.sceneOrbit}>
    <span className={styles.sceneTrack} />
    {ORBIT.map((point, i) => <OrbitDot key={i} index={i} point={point} launch={launch} reduce={reduce} />)}
    <span className={styles.sceneOrb} />
  </div>;
  return <div className={styles.sceneBoard}>
    {[0, 1, 2, 3].map((i) => <motion.span key={i} className={styles.sceneTile} data-wide={i === 0 || i === 3 || undefined}
      initial={reduce ? false : { opacity: 0, y: -18 }} animate={{ opacity: 1, y: 0 }}
      transition={reduce ? INSTANT : { ...SPRINGS.bouncy, delay: 0.3 + i * 0.18 }} />)}
  </div>;
}

function OrbitDot({ index, point, launch, reduce }: {
  index: number; point: { x: number; y: number }; launch: MotionValue<number>; reduce: boolean;
}) {
  // Every entity leaves the orb at the ring's centre.
  const x = useTransform(launch, [0, 1], [0, point.x]);
  const y = useTransform(launch, [0, 1], [0, point.y]);
  const opacity = useTransform(launch, [0, 0.15], [0, 1]);
  return <motion.span className={styles.sceneMark} style={{ x: reduce ? point.x : x, y: reduce ? point.y : y,
    opacity: reduce ? 1 : opacity, background: MARK[index] }} />;
}

function PlayGlyph({ playing }: { playing: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {playing ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /> : <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />}
  </svg>;
}

function Storyboard({ explainer, onClose }: { explainer: Explainer; onClose: () => void }) {
  const reduce = useReducedMotionConfig() ?? false;
  const scenes = explainer.scenes ?? [];
  const [scene, setScene] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [done, setDone] = useState(false);
  const t = useMotionValue(0);

  useEffect(() => {
    if (!playing || done) return;
    const remaining = (1 - t.get()) * SCENE_SECONDS;
    const controls = animate(t, 1, { duration: remaining, ease: "linear", onComplete: () => {
      if (scene + 1 < scenes.length) { t.set(0); setScene(scene + 1); } else { setPlaying(false); setDone(true); }
    } });
    return () => controls.stop();
  }, [playing, done, scene, scenes.length, t]);

  const toggle = () => {
    if (done) { t.set(0); setScene(0); setDone(false); setPlaying(true); return; }
    setPlaying((p) => !p);
  };
  const current = scenes[scene];
  return <div className={styles.storyboard}>
    <div className={styles.progress} aria-hidden="true">
      {scenes.map((item, i) => <span key={item.caption} className={styles.progressTrack}>
        <ProgressFill t={t} state={i < scene || done ? "full" : i === scene ? "live" : "empty"} />
      </span>)}
    </div>
    <div className={styles.sceneStage}>
      <AnimatePresence mode="popLayout" initial={false}>
        {current && <motion.div key={scene} className={styles.sceneFrame}
          initial={reduce ? false : { opacity: 0, scale: 0.96, filter: "blur(6px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 1.02, filter: "blur(6px)", transition: FADES.quick }}
          transition={reduce ? INSTANT : SPRINGS.smooth}>
          <Scene kind={current.kind} t={t} reduce={reduce} />
        </motion.div>}
      </AnimatePresence>
    </div>
    <p className={styles.caption} aria-live="polite">{current?.caption}</p>
    <div className={styles.controls}>
      <button type="button" className={`tap ${styles.control}`} onClick={toggle}
        aria-label={done ? "Play again" : playing ? "Pause" : "Play"}>
        {done ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6" /><path d="M4 4v4.6h4.6" /></svg> : <PlayGlyph playing={playing} />}
      </button>
      <span className={styles.controlMeta}>{scene + 1} of {scenes.length}</span>
      <button type="button" data-explainer-close="" className={`tap ${styles.control}`} onClick={onClose}
        aria-label={`Close ${explainer.title}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
  </div>;
}

function ProgressFill({ t, state }: { t: MotionValue<number>; state: "full" | "live" | "empty" }) {
  const live = useTransform(t, (v) => v);
  return <motion.span className={styles.progressFill}
    style={{ scaleX: state === "full" ? 1 : state === "empty" ? 0 : live }} />;
}

/** The corner radius the pin and the player share. It is given to Motion as a style so the corners
 *  stay round while the shared box is scaled between the two. */
const CORNER = { borderRadius: 16 } as const;

/** A player on its way back: the pin's box on the board, and the size the player had when it began. */
export type ExplainerClosing = { to: Box; from: { width: number; height: number } };

/** The pin's poster, title and length: drawn by the pin, and carried by the player at the pin's own
 *  size while it grows out of the pin and as it lands back in it. */
function PinFace({ explainer }: { explainer: Explainer }) {
  return <>
    <span className={styles.poster} aria-hidden="true">
      {explainer.poster ? <Image src={explainer.poster} alt="" fill sizes="112px" className={styles.posterImage} /> : <span className={styles.posterArt}>
        <span className={styles.posterTrack} />
        {ORBIT.map((point, i) => <span key={i} className={styles.posterDot}
          style={{ background: MARK[i], transform: `translate(${point.x * 0.42}px, ${point.y * 0.42}px)` }} />)}
      </span>}
      <span className={styles.play}><PlayGlyph playing={false} /></span>
    </span>
    <span className="flex min-w-0 flex-col gap-1 text-left">
      <span className={styles.eyebrow}>Explainer · {explainer.length}</span>
      <span className={styles.pinTitle}>{explainer.title}</span>
    </span>
  </>;
}

/**
 * The player that fills the board: a container transform out of its pin and back (one shared layout
 * id) on the board's morph timeline (components/today/useDayCardMotion.ts `BOARD_MORPH`), the same
 * one the tip view rides. The frame is opaque from the first frame to the last (`layoutCrossfade`:
 * Motion's crossfade started it at opacity 0 over a stretched copy of the pin, and faded it out
 * half-way through the close). It starts in the pin's ivory, with the pin's face at the pin's own
 * size, and turns dark as it grows; its content holds its own size and position (`layout="position"`)
 * and fades up a beat later, so the box's edge reveals it rather than stretching it.
 *
 * Closing (`closing`) is the open run backwards on the same spring: the dark frame shrinks into the
 * pin's box at full opacity, its content fading out first; the pin's ivory and face come back over
 * the last part, so it lands as the pin, and the stage then hands over to the pin (`onClosed`).
 */
export default function ExplainerPlayer({ explainer, onClose, pinSize = null, closing = null, onClosed, ref }: {
  explainer: Explainer;
  onClose: () => void;
  /** The pin's size when the player opened from it. */
  pinSize?: { width: number; height: number } | null;
  closing?: ExplainerClosing | null;
  /** The shrink has landed in the pin. */
  onClosed?: () => void;
  ref?: Ref<HTMLElement>;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const t = boardMorph(reduce);
  // Shrinking back into its pin, the player is already gone for assistive tech and the keyboard.
  const present = useIsPresent();
  const away = !present || closing !== null;
  // Every explainer, video or storyboard, takes focus on open: its close control, else the player
  // itself, so Escape (handled on the player) works from the keyboard at once.
  const self = useRef<HTMLElement | null>(null);
  const setSelf = useCallback((el: HTMLElement | null) => {
    self.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  }, [ref]);
  useEffect(() => {
    const root = self.current;
    if (!root || root.contains(document.activeElement)) return;
    (root.querySelector<HTMLElement>("[data-explainer-close]") ?? root).focus({ preventScroll: true });
  }, []);
  const box = closing
    ? { position: "absolute" as const, top: closing.to.top, left: closing.to.left, width: closing.to.width, height: closing.to.height }
    : null;
  return <motion.section ref={setSelf} tabIndex={-1} aria-label={explainer.title} className={`matte matte-grain ${styles.player}`}
    data-explainer-player={explainer.id} data-closing={closing ? "" : undefined}
    style={{ ...CORNER, ...box }} inert={away} aria-hidden={away ? true : undefined}
    layoutId={reduce ? undefined : `explainer-${explainer.id}`} layoutCrossfade={false} transition={t.frame}
    onLayoutAnimationComplete={closing ? onClosed : undefined}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    {!reduce && <motion.span className={styles.playerVeil} data-explainer-veil="" aria-hidden="true"
      initial={{ opacity: 1 }} animate={{ opacity: closing ? 1 : 0 }}
      transition={closing ? t.surfaceIn : t.surfaceOut} />}
    <motion.div className={styles.playerInner} layout={reduce ? false : "position"}
      style={closing ? { position: "absolute", top: 0, left: 0, width: closing.from.width, height: closing.from.height } : undefined}
      initial={reduce ? false : { opacity: 0 }} animate={{ opacity: closing ? 0 : 1 }}
      transition={{ opacity: closing ? t.contentOut : t.contentIn, layout: t.frame }}>
      <h3 className={styles.playerTitle}>{explainer.title}</h3>
      {explainer.src
        ? <video className={styles.video} src={explainer.src} poster={explainer.poster} controls playsInline autoPlay />
        : <Storyboard explainer={explainer} onClose={onClose} />}
      {explainer.src && <button type="button" data-explainer-close="" className={`tap ${styles.control} ${styles.videoClose}`}
        onClick={onClose} aria-label={`Close ${explainer.title}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>}
    </motion.div>
    {pinSize && !reduce && <motion.div className={`matte-reset ${styles.pin} ${styles.pinFace}`} data-explainer-face=""
      aria-hidden="true" layout="position" style={{ width: pinSize.width, height: pinSize.height }}
      initial={{ opacity: 1 }} animate={{ opacity: closing ? 1 : 0 }}
      transition={{ opacity: closing ? t.faceIn : t.faceOut, layout: t.frame }}>
      <PinFace explainer={explainer} />
    </motion.div>}
  </motion.section>;
}

/** Focus that was in the player, or went nowhere when the player turned inert, goes back to the pin. */
function focusWasInPlayer(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.closest("[data-explainer-player]") !== null;
}

/**
 * The board's two states: its pins, or one explainer's player over them (2026-10-03). The pins stay
 * mounted under the player, out of the flow in exactly the box they had, inert and hidden from
 * assistive tech, and they fade and blur away underneath while the player grows over them, never
 * cut on the first frame; nothing on the board remounts when the player closes, so no tile reloads
 * its photo or forgets its place. Closing runs the open backwards (useDayCardMotion.ts
 * `BOARD_MORPH`): the player shrinks into its pin while the tiles fade back in, and only once it has
 * landed does the pin take over. The board's height (DayBoard's one AutoHeight) springs between
 * the two on the frame's own spring, so the card follows the frame. Focus moves to the player's close button
 * (every explainer, video or storyboard) and back to the pin without scrolling the page. A board that leaves the screen closes its player at once, so it
 * never plays unseen.
 */
export function ExplainerStage({ explainers, active, children }: {
  explainers: Explainer[];
  /** False while another face of the Day card is on show. */
  active: boolean;
  children: (play: (id: string, from?: HTMLElement) => void) => ReactNode;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const t = boardMorph(reduce);
  const [playing, setPlaying] = useState<string | null>(null);
  const [pinSize, setPinSize] = useState<{ width: number; height: number } | null>(null);
  const [closing, setClosing] = useState<ExplainerClosing | null>(null);
  if (!active && playing !== null) { setPlaying(null); setClosing(null); }
  const shown = explainers.find((item) => item.id === playing) ?? null;
  // The tiles are covered while the player is open; closing, they are back in the flow, fading in.
  const covered = shown !== null && closing === null;
  const stage = useRef<HTMLDivElement | null>(null);
  // Closing a player hands focus back to the pin it grew from.
  const closedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (playing !== null) return;
    // The player hid its pin while it stood in for it (`layoutCrossfade`); Motion shows it
    // again as it projects it back, and this makes sure it is shown once the player has handed over.
    stage.current?.querySelectorAll<HTMLElement>("[data-explainer-pin]").forEach(unhide);
    const id = closedFrom.current;
    if (id === null) return;
    closedFrom.current = null;
    if (!focusWasInPlayer()) return;
    stage.current?.querySelector<HTMLElement>(`[data-explainer-pin="${id}"]`)?.focus({ preventScroll: true });
  }, [playing]);

  const finish = useCallback(() => { setClosing(null); setPlaying(null); }, []);
  // The shrink reports its landing; if it never does (nothing to travel), the pin takes over anyway.
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(finish, MORPH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [closing, finish]);

  const pinOf = (id: string) => stage.current?.querySelector<HTMLElement>(`[data-explainer-pin="${id}"]`) ?? null;
  /** `from` is the pin that was tapped: the player carries its face at its size. */
  const play = (id: string, from?: HTMLElement) => {
    setPinSize(from ? { width: from.offsetWidth, height: from.offsetHeight } : null);
    setClosing(null);
    setPlaying(id);
  };
  const close = () => {
    if (!shown || closing) return;
    closedFrom.current = shown.id;
    const root = stage.current;
    const pin = pinOf(shown.id);
    const player = root?.querySelector<HTMLElement>("[data-explainer-player]");
    if (reduce || !root || !pin || !player) { finish(); return; }
    setClosing({ to: boxWithin(pin, root), from: { width: player.offsetWidth, height: player.offsetHeight } });
  };

  return <LayoutGroup>
    <div ref={stage} className={styles.board} data-playing={covered ? "" : undefined}>
      <motion.div className={styles.grid} data-covered={covered ? "" : undefined}
        inert={covered} aria-hidden={covered ? true : undefined}
        initial={false} animate={covered ? TILES_COVERED : TILES_SHOWN}
        transition={covered ? t.tilesOut : t.tilesIn}>
        {children(play)}
      </motion.div>
      <AnimatePresence initial={false}>
        {shown && <ExplainerPlayer key={shown.id} explainer={shown} pinSize={pinSize} closing={closing}
          onClose={close} onClosed={finish} />}
      </AnimatePresence>
    </div>
  </LayoutGroup>;
}

/** The explainer's pin on the board: a poster with a play glyph, its title and length. */
function Pin({ explainer, onPlay }: { explainer: Explainer; onPlay: (from: HTMLElement) => void }) {
  const reduce = useReducedMotionConfig() ?? false;
  return <motion.button type="button" className={`tap ${styles.pin}`} onClick={(event) => onPlay(event.currentTarget)} data-explainer-pin={explainer.id}
    aria-label={`Play ${explainer.title}, ${explainer.length}`} style={CORNER}
    layoutId={reduce ? undefined : `explainer-${explainer.id}`} transition={reduce ? INSTANT : BOARD_MORPH.frame}
    whileTap={reduce ? undefined : { scale: 0.98 }}>
    <PinFace explainer={explainer} />
  </motion.button>;
}

ExplainerPlayer.Pin = Pin;
