"use client";

import { ASSISTANT_NAME } from "@/lib/brand";
import Image from "next/image";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { SearchIcon } from "@/components/ui/icons";
import { TourIcon } from "@/components/tour/TourIcons";
import Chip from "@/components/ui/Chip";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import type { TourDemoKind } from "@/components/tour/tour-steps";
import { useDemoClock } from "@/components/tour/useDemoClock";
import styles from "@/components/tour/AppTour.module.css";

/**
 * The overview's animated demos (owner, 2026-10-08: "a ghost finger performing the gesture on the
 * mini card"). Each is a few poses on a beat clock (useDemoClock); between poses every part moves on
 * one of the house springs. The card is a simplified drawing of the meal card, not the real
 * component, so the overview never depends on its internals. Decorative: the step's words say
 * everything a demo shows, so the whole stage is hidden from assistive tech. Reduced motion draws
 * one still frame per demo (the gesture demo's chips still choose which frame).
 */

/* Card geometry, px, shared with AppTour.module.css: photo 56, body 40, strip 36 (three equal
   80 px icon zones), so the card is 132 tall closed. */
const STRIP_Y = 114;
const MARK_X = 40;
const CHEVRON_X = 200;
/* Opened: a 48 px compact header, then the tray, then the strip. */
const ROW1_Y = 68;
const ROW2_Y = 96;
const PLUS_X = 198;
const REMOVE_X = 214;

type Finger = { x: number; y: number; down?: boolean; hold?: boolean } | null;

const move = (reduce: boolean) => reduce ? INSTANT : SPRINGS.smooth;
const press = (reduce: boolean) => reduce ? INSTANT : SPRINGS.snappy;
const fadeIn = (reduce: boolean) => reduce ? INSTANT : FADES.base;

function GhostFinger({ at, reduce, taps }: { at: Finger; reduce: boolean; taps: number }) {
  return <motion.span className={styles.finger} data-finger="" initial={false}
    animate={{ x: at?.x ?? 120, y: at?.y ?? 220, opacity: at ? 1 : 0, scale: at?.down ? 0.82 : 1 }}
    transition={{ x: move(reduce), y: move(reduce), scale: press(reduce), opacity: fadeIn(reduce) }}>
    {!reduce && <AnimatePresence>
      {at?.down && !at.hold && <motion.span key={taps} className={styles.ripple}
        initial={{ opacity: 0.7, scale: 0.6 }} animate={{ opacity: 0, scale: 1.6 }} exit={{ opacity: 0 }}
        transition={{ scale: SPRINGS.smooth, opacity: FADES.base }} />}
    </AnimatePresence>}
    <AnimatePresence>
      {at?.hold && <motion.span key="hold" className={styles.holdRing}
        initial={reduce ? false : { opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0 }} transition={reduce ? INSTANT : SPRINGS.bouncy} />}
    </AnimatePresence>
  </motion.span>;
}

function Check() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7" /></svg>;
}

/** A still frame's direction mark beside the finger. */
function Arrow({ x, y, dir }: { x: number; y: number; dir: "left" | "right" | "up" }) {
  const d = dir === "right" ? "M4 12h14m-5-5 5 5-5 5" : dir === "left" ? "M20 12H6m5-5-5 5 5 5" : "M12 20V6m-5 5 5-5 5 5";
  return <span className={styles.arrow} style={{ transform: `translate(${x}px, ${y}px)` }}>
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  </span>;
}

export type MiniCardState = {
  chip: string;
  tone?: "next" | "now" | "eaten";
  eaten?: boolean;
  open?: boolean;
  amount?: string;
  removed?: boolean;
  lifted?: boolean;
  favorite?: boolean;
};

/** The simplified meal card (meal-cards-v3): a compact photo with its chip and the favorite heart,
 *  the title and calories, and a thin strip of three equal icon zones (Mark eaten, Swap, Expand);
 *  opened, a compact header (thumbnail, title, kcal and P/C/F) over its ingredients with − / + and
 *  ×, and search, the strip still at the foot. */
export function MiniMealCard({ state, reduce }: { state: MiniCardState; reduce: boolean }) {
  return <motion.div className={`matte ${styles.card}`} initial={false}
    animate={{ scale: state.lifted ? 1.04 : 1 }} transition={press(reduce)}>
    <motion.div initial={false} animate={{ height: !state.open ? "auto" : 0, opacity: !state.open ? 1 : 0 }}
      transition={reduce ? INSTANT : { height: SPRINGS.gentle, opacity: FADES.base }} className="overflow-hidden">
      <div className={styles.photo}>
        <Image src="/meal-art/rice-bowl.webp" alt="" fill sizes="240px" className={styles.photoImg} draggable={false} />
        <motion.span layout={!reduce} className={`matte-reset ${styles.chip}`} data-tone={state.tone ?? "next"}
          transition={press(reduce)}>
          {state.tone === "eaten" && <Check />}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={state.chip} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }} transition={reduce ? INSTANT : SPRINGS.snappy}>{state.chip}</motion.span>
          </AnimatePresence>
        </motion.span>
        <span className={`matte-reset ${styles.heart}`} data-on={state.favorite || undefined}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={state.favorite ? "on" : "off"} className="flex" initial={reduce ? false : { scale: 0.5 }}
              animate={{ scale: 1 }} exit={{ opacity: 0 }} transition={reduce ? INSTANT : SPRINGS.bouncy}>
              <TourIcon name={state.favorite ? "hearted" : "heart"} size={14} />
            </motion.span>
          </AnimatePresence>
        </span>
      </div>
      <div className={styles.body}>
        <span className={`font-display text-charcoal ${styles.title}`}>Chicken rice bowl</span>
        <span className={`kcal ${styles.kcal}`}>540 <span className="text-muted">kcal</span></span>
      </div>
    </motion.div>
    <motion.div initial={false} animate={{ height: state.open ? "auto" : 0, opacity: state.open ? 1 : 0 }}
      transition={reduce ? INSTANT : { height: SPRINGS.gentle, opacity: FADES.base }} className="overflow-hidden">
      {/* Opened (meal-cards-v3): a compact header — thumbnail, title, kcal and P/C/F inline — so the
          ingredients sit near the top. */}
      <div className={styles.openHead}>
        <span className={styles.dayThumb}>
          <Image src="/meal-art/rice-bowl.webp" alt="" fill sizes="36px" className={styles.photoImg} draggable={false} />
        </span>
        <span className={styles.dayText}>
          <span className={`font-display text-charcoal ${styles.dayTitle}`}>Chicken rice bowl</span>
          <span className={`text-muted ${styles.macros}`}><span className="kcal">540</span> kcal · P 42 · C 58 · F 14</span>
        </span>
      </div>
      <div className={`matte-reset ${styles.tray}`}>
        <div className={styles.row}>
          <span className={styles.rowName}>Chicken</span>
          <span className={styles.glyph}>−</span>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={state.amount ?? "150 g"} className={styles.rowAmount}
              initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              transition={reduce ? INSTANT : SPRINGS.snappy}>{state.amount ?? "150 g"}</motion.span>
          </AnimatePresence>
          <span className={styles.glyph}>+</span>
          <span className={styles.glyph}>×</span>
        </div>
        <motion.div initial={false} animate={{ height: state.removed ? 0 : 28, opacity: state.removed ? 0 : 1 }}
          transition={reduce ? INSTANT : { height: SPRINGS.smooth, opacity: FADES.quick }} className="overflow-hidden">
          <div className={styles.row}>
            <span className={styles.rowName}>Rice</span>
            <span className={styles.glyph}>−</span>
            <span className={styles.rowAmount}>1 cup</span>
            <span className={styles.glyph}>+</span>
            <span className={styles.glyph}>×</span>
          </div>
        </motion.div>
        <div className={`${styles.search} text-muted`}><SearchIcon size={12} />&nbsp;Search to add</div>
      </div>
    </motion.div>
    <div className={styles.strip}>
      <span className={`${styles.zone} text-charcoal`} data-on={state.eaten || undefined} data-zone="eaten">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={state.eaten ? "on" : "off"} className="flex" initial={reduce ? false : { scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }} transition={reduce ? INSTANT : SPRINGS.bouncy}>
            <TourIcon name={state.eaten ? "checked" : "check"} />
          </motion.span>
        </AnimatePresence>
      </span>
      <span className={`${styles.zone} text-charcoal`} data-zone="swap"><TourIcon name="swap" /></span>
      <motion.span className={`${styles.zone} text-charcoal`} data-zone="expand" initial={false}
        animate={{ rotate: state.open ? 180 : 0 }} transition={press(reduce)}>
        <TourIcon name="expand" />
      </motion.span>
    </div>
  </motion.div>;
}

/* ---- step 1: what the app is ----------------------------------------------------------------- */

const MEET_BEATS = [700, 700, 700, 1100, 500, 1600] as const;

function MeetDemo({ reduce }: { reduce: boolean }) {
  const beat = useDemoClock(MEET_BEATS, reduce, 5);
  const rows = [
    { time: "8:00 AM", title: "Oats and berries", art: "/meal-art/oats-porridge.webp" },
    { time: "12:30 PM", title: "Chicken rice bowl", art: "/meal-art/rice-bowl.webp" },
    { time: "6:30 PM", title: "Salmon and potatoes", art: "/meal-art/salmon.webp" },
  ];
  const ticked = beat >= 4;
  const finger: Finger = beat === 3 ? { x: 214, y: 26 } : beat === 4 ? { x: 214, y: 26, down: true } : null;
  return <div className={styles.rig} data-beat={beat}>
    <div className={styles.dayList}>
      {rows.map((row, i) => <motion.div key={row.time} className={`matte ${styles.dayRow}`} initial={false}
        animate={{ opacity: beat >= i ? 1 : 0, y: beat >= i ? 0 : 16 }}
        transition={reduce ? INSTANT : { y: SPRINGS.bouncy, opacity: FADES.base }}>
        <span className={styles.dayThumb}>
          <Image src={row.art} alt="" fill sizes="36px" className={styles.photoImg} draggable={false} />
        </span>
        <span className={styles.dayText}>
          <span className={`${styles.dayTime} text-muted`}>{row.time}</span>
          <span className={`${styles.dayTitle} text-charcoal`}>{row.title}</span>
        </span>
        <span className={`${styles.tick} text-charcoal`} data-on={(i === 0 && ticked) || undefined}>
          {i === 0 && ticked && <Check />}
        </span>
      </motion.div>)}
    </div>
    <motion.div className={styles.foods} initial={false} animate={{ opacity: beat >= 2 ? 1 : 0 }}
      transition={fadeIn(reduce)}>
      <span className={styles.food}>Your foods</span>
      <span className={styles.food}>Your targets</span>
    </motion.div>
    <GhostFinger at={finger} reduce={reduce} taps={beat} />
  </div>;
}

/* ---- step 2: the card at a glance ------------------------------------------------------------ */

const GLANCE_BEATS = [1300, 1300, 1300, 1300, 1300, 1300] as const;
const GLANCE = [
  { chip: "Next · 12:30 PM", tone: "next", box: { x: 4, y: 4, w: 128, h: 30 }, label: "When: next, now or eaten", favorite: false },
  { chip: "Now", tone: "now", box: { x: 4, y: 4, w: 56, h: 30 }, label: "Now is the meal to eat", favorite: false },
  { chip: "Now", tone: "now", box: { x: 4, y: 58, w: 160, h: 36 }, label: "The meal and its calories", favorite: false },
  { chip: "Now", tone: "now", box: { x: 202, y: 4, w: 34, h: 30 }, label: "The heart: a favorite meal", favorite: true },
  { chip: "Now", tone: "now", box: { x: 2, y: 96, w: 236, h: 34 }, label: "Mark eaten · Swap · Expand", favorite: true },
  { chip: "Eaten", tone: "eaten", box: { x: 4, y: 4, w: 72, h: 30 }, label: "Eaten, once you tick it off", favorite: true },
] as const;

function GlanceDemo({ reduce }: { reduce: boolean }) {
  const beat = useDemoClock(GLANCE_BEATS, reduce, 0);
  const pose = GLANCE[beat];
  return <div className={styles.rig} data-beat={beat}>
    <MiniMealCard reduce={reduce}
      state={{ chip: pose.chip, tone: pose.tone, eaten: pose.tone === "eaten", favorite: pose.favorite }} />
    <motion.span className={styles.highlight} initial={false}
      animate={{ x: pose.box.x, y: pose.box.y, width: pose.box.w, height: pose.box.h }}
      style={{ top: 0, left: 0 }} transition={reduce ? INSTANT : SPRINGS.snappy} />
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={pose.label} className={styles.callout} initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={reduce ? INSTANT : SPRINGS.snappy}>
        {pose.label}
      </motion.span>
    </AnimatePresence>
  </div>;
}

/* ---- step 3: taps ------------------------------------------------------------------------------- */

/* Poses: to Mark eaten, tap (eaten), tap again (undone), to the chevron, tap (open), to +, tap
   (175 g), to ×, tap (removed, Undo), rest. */
const TAPS_BEATS = [800, 800, 900, 700, 700, 900, 700, 900, 700, 1700, 600] as const;

function TapsDemo({ reduce }: { reduce: boolean }) {
  const beat = useDemoClock(TAPS_BEATS, reduce, 7);
  const eaten = beat === 1;
  const open = beat >= 4 && beat <= 9;
  const amount = beat >= 6 && beat <= 9 ? "175 g" : "150 g";
  const removed = beat === 9;
  const finger: Finger = [
    { x: MARK_X, y: STRIP_Y },
    { x: MARK_X, y: STRIP_Y, down: true },
    { x: MARK_X, y: STRIP_Y, down: true },
    { x: CHEVRON_X, y: STRIP_Y },
    { x: CHEVRON_X, y: STRIP_Y, down: true },
    { x: PLUS_X, y: ROW1_Y },
    { x: PLUS_X, y: ROW1_Y, down: true },
    { x: REMOVE_X, y: ROW2_Y },
    { x: REMOVE_X, y: ROW2_Y, down: true },
    null,
    null,
  ][beat] ?? null;
  return <>
    <div className={styles.rig} data-beat={beat}>
      <MiniMealCard reduce={reduce}
        state={{ chip: eaten ? "Eaten" : "Next · 12:30 PM", tone: eaten ? "eaten" : "next", eaten, open, amount, removed }} />
      <GhostFinger at={reduce ? null : finger} reduce={reduce} taps={beat} />
    </div>
    <AnimatePresence>
      {removed && <motion.div key="undo" className={styles.undo} initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} transition={reduce ? INSTANT : SPRINGS.bouncy}>
        <span>Rice removed</span><span className={styles.undoAction}>Undo · 5 s</span>
      </motion.div>}
    </AnimatePresence>
  </>;
}

/* ---- step 4: gestures --------------------------------------------------------------------------- */

type Gesture = "right" | "left" | "hold";
const GESTURES: { id: Gesture; label: string; short: string }[] = [
  { id: "right", label: "Swipe right", short: "Right" },
  { id: "left", label: "Swipe left", short: "Left" },
  { id: "hold", label: "Hold and drag", short: "Hold" },
];
const GESTURE_BEATS: Record<Gesture, readonly number[]> = {
  right: [600, 450, 1100, 900],
  left: [600, 450, 900, 1100, 900],
  hold: [600, 700, 700, 700, 900, 900],
};
const STILL: Record<Gesture, number> = { right: 2, left: 3, hold: 4 };
const sum = (beats: readonly number[]) => beats.reduce((a, b) => a + b, 0);

function GestureFrame({ gesture, beat, reduce }: { gesture: Gesture; beat: number; reduce: boolean }) {
  let x = 0;
  let y = 0;
  let lifted = false;
  let chip = "Next · 12:30 PM";
  let finger: Finger = null;
  if (gesture === "right") {
    x = beat === 2 ? 72 : 0;
    finger = beat === 1 ? { x: 70, y: 66, down: true } : beat === 2 ? { x: 142, y: 66, down: true } : beat === 0 ? { x: 70, y: 66 } : null;
  } else if (gesture === "left") {
    x = beat === 2 ? -70 : beat === 3 ? -140 : 0;
    finger = beat === 0 ? { x: 180, y: 66 } : beat === 1 ? { x: 180, y: 66, down: true }
      : beat === 2 ? { x: 110, y: 66, down: true } : beat === 3 ? { x: 40, y: 66, down: true } : null;
  } else {
    lifted = beat >= 1 && beat <= 4;
    y = beat === 2 ? -10 : beat === 3 || beat === 4 ? -20 : 0;
    chip = beat === 2 ? "Next · 12:15 PM" : beat === 3 || beat === 4 ? "Next · 12:00 PM" : "Next · 12:30 PM";
    finger = beat === 0 ? { x: 120, y: 66 } : beat >= 1 && beat <= 4 ? { x: 120, y: 66 + y, down: true, hold: true } : null;
  }
  const arrow = gesture === "right" ? { x: 108, y: 146, dir: "right" as const }
    : gesture === "left" ? { x: 108, y: 146, dir: "left" as const } : { x: 108, y: 146, dir: "up" as const };
  return <div className={styles.rig} data-beat={beat} data-gesture={gesture}>
    {gesture === "right" && <div className={`${styles.behind} ${styles.behindLeft}`}>
      <span className={`${styles.behindPill} ${styles.behindSwap}`}>Swap</span>
    </div>}
    {gesture === "left" && <div className={`${styles.behind} ${styles.behindRight}`}>
      <motion.span className={`${styles.behindPill} ${styles.behindDelete}`} initial={false}
        animate={{ opacity: x <= -140 ? 1 : 0.4 }} transition={fadeIn(reduce)}>Delete</motion.span>
      <span className={`${styles.behindPill} ${styles.behindClear}`}>Clear</span>
    </div>}
    <motion.div initial={false} animate={{ x, y }} transition={reduce ? INSTANT : SPRINGS.smooth}>
      <MiniMealCard reduce={reduce} state={{ chip, lifted }} />
    </motion.div>
    <GhostFinger at={finger} reduce={reduce} taps={beat} />
    {reduce && <Arrow {...arrow} />}
  </div>;
}

function GesturesDemo({ reduce }: { reduce: boolean }) {
  const [gesture, setGesture] = useState<Gesture>("right");
  const [picked, setPicked] = useState(false);
  const beat = useDemoClock(GESTURE_BEATS[gesture], reduce, STILL[gesture], gesture);
  // Each gesture plays once through, then the next takes over, until the user picks one.
  useEffect(() => {
    if (reduce || picked) return;
    const timer = setTimeout(() => {
      setGesture((g) => GESTURES[(GESTURES.findIndex((x) => x.id === g) + 1) % GESTURES.length].id);
    }, sum(GESTURE_BEATS[gesture]));
    return () => clearTimeout(timer);
  }, [gesture, picked, reduce]);
  return <>
    <div aria-hidden="true"><GestureFrame gesture={gesture} beat={beat} reduce={reduce} /></div>
    {/* The one part of a stage a person can use: it picks which gesture plays (or which still frame
        shows). It is a real control, so it stays reachable even though the drawing is hidden. */}
    <div className={`matte-reset pill-in ${styles.gestureChips}`} role="group" aria-label="Gesture to show">
      {GESTURES.map((g) => <Chip key={g.id} selected={g.id === gesture} aria-label={g.label}
        onClick={() => { setPicked(true); setGesture(g.id); }}>{g.short}</Chip>)}
    </div>
  </>;
}

/* ---- step 5: the coach ---------------------------------------------------------------------------- */

const COACH_BEATS = [700, 500, 500, 600, 700, 1800, 600] as const;
const WORDS = ["Move", "Move lunch", "Move lunch to 1 PM"];

function CoachDemo({ reduce }: { reduce: boolean }) {
  const beat = useDemoClock(COACH_BEATS, reduce, 5);
  const typed = beat >= 1 && beat <= 3 ? WORDS[beat - 1] : "";
  const sent = beat >= 4 && beat <= 5;
  const moved = beat === 5;
  return <>
    <div className={styles.rig} data-beat={beat}>
      <MiniMealCard reduce={reduce} state={{ chip: moved ? "Next · 1:00 PM" : "Next · 12:30 PM" }} />
    </div>
    <AnimatePresence>
      {sent && <motion.div key="reply" className={`matte-reset ${styles.reply}`} data-section="coach"
        initial={reduce ? false : { opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0 }} transition={reduce ? INSTANT : SPRINGS.bouncy}>
        {moved ? "Done. Lunch is at 1:00 PM now." : "Moving lunch…"}
      </motion.div>}
    </AnimatePresence>
    <div className={styles.composer}>
      <span className={styles.composerText}>
        {typed ? typed : <span className={styles.composerHint}>{`Ask ${ASSISTANT_NAME}`}</span>}
      </span>
      <span className={styles.mic}>
        {!reduce && beat === 0 && <motion.span className={styles.micPulse} initial={{ opacity: 0.7, scale: 1 }}
          animate={{ opacity: 0, scale: 1.5 }} transition={SPRINGS.smooth} />}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      </span>
    </div>
  </>;
}

/** The stage for one step. Only the gesture chips inside it can be reached; the drawing is hidden. */
export default function TourDemo({ kind, reduce }: { kind: TourDemoKind; reduce: boolean }) {
  return <div className={styles.stage} data-demo={kind} data-still={reduce || undefined}>
    <div aria-hidden="true">
      {kind === "meet" && <MeetDemo reduce={reduce} />}
      {kind === "glance" && <GlanceDemo reduce={reduce} />}
      {kind === "taps" && <TapsDemo reduce={reduce} />}
      {kind === "coach" && <CoachDemo reduce={reduce} />}
    </div>
    {kind === "gestures" && <GesturesDemo reduce={reduce} />}
  </div>;
}
