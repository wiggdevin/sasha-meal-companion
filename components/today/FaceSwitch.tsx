"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { animate, motion, useMotionTemplate, useMotionValue, useTransform, useVelocity } from "motion/react";
import { LEAD_EDGE, TAB_MOVE, TRAIL_EDGE } from "@/components/dock/dock-motion";
import { INSTANT } from "@/lib/design/motion";
import styles from "@/components/today/DayCard.module.css";

export type DayFace = "calendar" | "overview" | "board";

const LABEL: Record<DayFace, string> = { calendar: "Calendar", overview: "Overview", board: "Board" };

/* Geometry (px): a 44 px track with 4 px padding. An idle segment is a 36 px glyph; the chosen one
   widens to carry its name, sized to the name so the lens hugs it. */
const PAD = 4;
const GAP = 2;
const GLYPH = 36;
const ACTIVE: Record<DayFace, number> = { calendar: 108, overview: 110, board: 88 };

type Slot = { x: number; w: number };

export function faceSlots(faces: DayFace[], active: DayFace): Slot[] {
  let x = PAD;
  return faces.map((face) => {
    const slot = { x, w: face === active ? ACTIVE[face] : GLYPH };
    x += slot.w + GAP;
    return slot;
  });
}

export function trackWidth(faces: DayFace[], active: DayFace): number {
  const slots = faceSlots(faces, active);
  const last = slots[slots.length - 1];
  return last ? last.x + last.w + PAD : 0;
}

function Glyph({ face }: { face: DayFace }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (face === "calendar") return <svg {...common}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="4" /><path d="M3.5 10h17M8 3v4M16 3v4" />
    <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
  </svg>;
  if (face === "overview") return <svg {...common}>
    <circle cx="12" cy="12" r="3.2" /><ellipse cx="12" cy="12" rx="9.5" ry="4.6" transform="rotate(-24 12 12)" />
    <circle cx="19.6" cy="8.2" r="1.3" fill="currentColor" stroke="none" />
  </svg>;
  return <svg {...common}>
    <rect x="3.5" y="3.5" width="17" height="7" rx="2.5" /><rect x="3.5" y="13.5" width="7.5" height="7" rx="2.5" />
    <rect x="13" y="13.5" width="7.5" height="7" rx="2.5" />
  </svg>;
}

function Face({ face, active, reduce }: { face: DayFace; active: boolean; reduce: boolean }) {
  return <span className="flex items-center justify-center gap-1.5">
    <Glyph face={face} />
    {/* shrink-0: the name is measured at its full width even while its segment is still narrow. */}
    <motion.span className="shrink-0 overflow-hidden whitespace-nowrap text-[14px] font-medium" initial={false}
      animate={active ? { opacity: 1, width: "auto", filter: "blur(0px)" } : { opacity: 0, width: 0, filter: "blur(4px)" }}
      transition={reduce ? INSTANT : { ...TAB_MOVE, opacity: { duration: 0.2, delay: active ? 0.06 : 0 } }}>
      {LABEL[face]}
    </motion.span>
  </span>;
}

/** The lens rides two springs, the leading edge quicker than the trailing one, so it stretches in
 *  flight like a drop being pulled and lands soft (the dock's lens, components/dock/TabCapsule). */
function useLens(slot: Slot | null, reduce: boolean) {
  const left = useMotionValue(slot?.x ?? 0);
  const right = useMotionValue(slot ? slot.x + slot.w : 0);
  const placed = useRef(false);
  const x = slot?.x ?? null;
  const r = slot ? slot.x + slot.w : null;
  useLayoutEffect(() => {
    if (x === null || r === null) return;
    if (!placed.current || reduce) { left.jump(x); right.jump(r); placed.current = true; return; }
    const rightward = x > left.get();
    const a = animate(left, x, rightward ? TRAIL_EDGE : LEAD_EDGE);
    const b = animate(right, r, rightward ? LEAD_EDGE : TRAIL_EDGE);
    return () => { a.stop(); b.stop(); };
  }, [x, r, reduce, left, right]);
  const width = useTransform(() => right.get() - left.get());
  const speed = useVelocity(left);
  const scaleY = useTransform(speed, [-1800, 0, 1800], [0.84, 1, 0.84]);
  return { left, right, width, scaleY };
}

/**
 * The Day card's face switch (2026-10-01; rulings: Jev chose header segments over swipe paging, which
 * would fight the week strip's horizontal scrub). A recessed track; the chosen face wears the olive
 * lens with its name, the others are glyphs. It is a tab list: arrows move between faces.
 */
export default function FaceSwitch({ faces, active, onChange, reduce, panelId }: {
  faces: DayFace[]; active: DayFace; onChange: (face: DayFace) => void; reduce: boolean;
  /** Id prefix of the face panels this list controls (`${panelId}-${face}`). */
  panelId: string;
}) {
  const slots = faceSlots(faces, active);
  const width = trackWidth(faces, active);
  const lens = useLens(slots[faces.indexOf(active)] ?? null, reduce);
  const layerWidth = useMotionValue(width);
  useLayoutEffect(() => { layerWidth.set(width); }, [width, layerWidth]);
  const rightInset = useTransform(() => layerWidth.get() - lens.right.get());
  const reveal = useMotionTemplate`inset(0px ${rightInset}px 0px ${lens.left}px round 9999px)`;
  // Under reduced motion the lens jumps, and a jumped value does not always reach the template, so
  // the cream layer is clipped straight to the chosen slot instead.
  const chosen = slots[faces.indexOf(active)];
  const still = chosen ? `inset(0px ${width - chosen.x - chosen.w}px 0px ${chosen.x}px round 9999px)` : "inset(0px 100%)";
  // The first paint lands in place; only later changes travel.
  const [live, setLive] = useState(false);
  useEffect(() => { const frame = requestAnimationFrame(() => setLive(true)); return () => cancelAnimationFrame(frame); }, []);
  const tabs = useRef(new Map<DayFace, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent, face: DayFace) => {
    const index = faces.indexOf(face);
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -index, End: faces.length - 1 - index }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = faces[(index + step + faces.length) % faces.length];
    onChange(next);
    // The tab is in view already; focusing it must never scroll the page under the card.
    tabs.current.get(next)?.focus({ preventScroll: true });
  };

  const segments = (layer: "base" | "ink") => faces.map((face, index) => {
    const slot = slots[index];
    const position = { initial: false as const, animate: { x: slot.x, width: slot.w },
      transition: reduce || !live ? INSTANT : TAB_MOVE };
    const isActive = face === active;
    if (layer === "ink") return <motion.span key={face} aria-hidden="true" className={styles.segment}
      style={{ position: "absolute", left: 0, top: PAD }} {...position}>
      <Face face={face} active={isActive} reduce={reduce} />
    </motion.span>;
    return <motion.button key={face} type="button" role="tab" id={`${panelId}-tab-${face}`}
      ref={(el) => { if (el) tabs.current.set(face, el); else tabs.current.delete(face); }}
      aria-selected={isActive} aria-controls={`${panelId}-${face}`} tabIndex={isActive ? 0 : -1}
      aria-label={LABEL[face]}
      className={`${styles.segment} ${styles.segmentButton}`}
      style={{ position: "absolute", left: 0, top: PAD }} {...position}
      whileTap={reduce ? undefined : { scale: 0.92 }}
      onClick={() => onChange(face)} onKeyDown={(event) => onKeyDown(event, face)}>
      <Face face={face} active={isActive} reduce={reduce} />
    </motion.button>;
  });

  return <motion.div role="tablist" aria-label="Day card views" className={styles.track}
    initial={false} animate={{ width }} transition={reduce || !live ? INSTANT : TAB_MOVE}>
    <motion.span aria-hidden="true" className={styles.switchLens}
      style={{ x: lens.left, width: lens.width, scaleY: lens.scaleY, top: PAD }} />
    {segments("base")}
    <motion.div aria-hidden="true" className={styles.switchInk} style={{ clipPath: reduce ? still : reveal }}>
      {segments("ink")}
    </motion.div>
  </motion.div>;
}
