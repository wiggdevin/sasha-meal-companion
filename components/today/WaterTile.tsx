"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import WaterLiquid from "@/components/today/WaterLiquid";
import { requestTiltPermission, useWaterTilt } from "@/components/today/useWaterTilt";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import { selectionHaptic } from "@/lib/haptics";
import type { OrbitWater } from "@/lib/today/health-orbit";
import { guardSelection, MAX_CUPS } from "@/lib/today/water-gesture";
import { fillFraction } from "@/lib/today/water-liquid";
import { clampPending, createWaterScrub, scrubParts, scrubText } from "@/lib/today/water-scrub";
import {
  formatWater, formatWaterDelta, formatWaterOf, stepLabel, stepPhrase, unitWord, waterNumber, waterValue,
  type WaterUnit,
} from "@/lib/water-units";
import styles from "@/components/today/WaterTile.module.css";

/**
 * The board's water tile (2026-10-03; it lived inside DayBoard.tsx until then).
 *
 * - A tap adds one step: 8 oz, a cup or 237 ml, which is one stored cup.
 * - Hold about a third of a second and slide: a bar opens above the tile and counts in the
 *   account's unit, faster the farther right the finger goes (lib/today/water-scrub.ts). Letting go
 *   writes the new total once through `onSetCups`; letting go at zero, or Escape, changes nothing.
 *   The total is the count the bar was opened on plus the amount slid, capped at MAX_CUPS: a sync
 *   that lands mid-slide does not move the base under the finger (audit r4).
 * - Keyboard: the arrow keys choose a pending amount, Enter logs it, Escape drops it. The arrows
 *   do nothing while a slide is open, and opening or finishing a slide drops any keyed amount, so
 *   the next tap adds one step instead of logging a stale total on top of the slide (audit r4).
 * - The water fills to the day's share of the goal, sloshes, and leans with the phone
 *   (WaterLiquid.tsx, useWaterTilt.ts). The first tap asks iOS for the motion sensor; nothing
 *   asks on load. Under reduced motion the water is still and level.
 */
type Props = {
  water?: OrbitWater;
  onAddCup?: () => void;
  /** The day's new total in cups, written once (the scrub and the keyboard amount). */
  onSetCups?: (cups: number) => void;
  /** The board is the face on show: only then does the water move. */
  active?: boolean;
};

type Scrub = { pending: number; top: number; base: number };

const capped = (cups: number) => Math.min(MAX_CUPS, Math.max(0, cups));

/** Above the tile, or under it when the tile sits too near the top of the screen. */
function barTop(tile: HTMLElement | null): number {
  const rect = tile?.getBoundingClientRect();
  if (!rect) return 16;
  const above = rect.top - 108;
  return above >= 12 ? above : rect.bottom + 12;
}

function ScrubBar({ cups, goal, pending, unit }: { cups: number; goal: number; pending: number; unit: WaterUnit }) {
  const total = Math.max(0, cups + pending);
  const scale = Math.max(goal, cups, total, 1);
  const pct = (cups: number) => `${Math.min(100, (cups / scale) * 100)}%`;
  const low = Math.min(cups, total);
  const { delta, after } = scrubParts(cups, pending, goal, unit);
  return <div className={styles.scrubCard}>
    <span className={styles.scrubLabel} role="status" aria-live="polite">
      {delta} <span className={styles.scrubTotal}>→ {after}</span>
    </span>
    <span className={styles.scrubTrack} aria-hidden="true">
      <span className={styles.scrubBase} style={{ width: pct(low) }} />
      {pending !== 0 && <span className={styles.scrubAdd} data-remove={pending < 0 || undefined}
        style={{ left: pct(low), width: pct(Math.abs(pending)) }} />}
      {goal > 0 && <span className={styles.scrubGoal} style={{ left: pct(goal) }} />}
    </span>
    <span className={styles.scrubHint} aria-hidden="true">
      {pending === 0 ? "Slide right to add, left to take back" : "Let go to log it"}
    </span>
  </div>;
}

export default function WaterTile({ water, onAddCup, onSetCups, active = true }: Props) {
  const reduce = useReducedMotionConfig() ?? false;
  const tilt = useWaterTilt(active && !reduce);
  const hintId = useId();
  const tileRef = useRef<HTMLButtonElement>(null);
  const [splash, setSplash] = useState(0);
  const [scrub, setScrub] = useState<Scrub | null>(null);
  const [keyed, setKeyed] = useState(0);
  // A lift that ended a hold or an abandoned press must not also count as the tile's click.
  const suppressClick = useRef(false);
  const pressed = useRef(false);
  // Built once; it reads the latest props through a holder an effect keeps current (WaterDial's
  // pattern), so a re-render never rebuilds the machine mid-hold.
  const [rig] = useState(() => {
    const latest: { cups: number; onSetCups?: (cups: number) => void; tile: HTMLElement | null } =
      { cups: 0, tile: null };
    // The count the press started on: the bar was clamped against it, so the commit adds to it.
    let base = 0;
    let release: (() => void) | null = null;
    const close = () => { release?.(); release = null; setScrub(null); };
    const machine = createWaterScrub({
      onHold: () => {
        release = guardSelection(document);
        setKeyed(0);
        setScrub({ pending: 0, top: barTop(latest.tile), base });
        selectionHaptic();
      },
      onStep: (pending) => { setScrub((s) => (s ? { ...s, pending } : s)); selectionHaptic(); },
      onCommit: (pending) => {
        close(); setKeyed(0); setSplash((n) => n + 1); latest.onSetCups?.(capped(base + pending));
      },
      onCancel: close,
    });
    return {
      machine,
      press(x: number, y: number, cups: number) { base = cups; machine.down(x, y, cups, MAX_CUPS); },
      update(next: typeof latest) { Object.assign(latest, next); },
      dispose() { machine.cancel(); release?.(); release = null; },
    };
  });
  useEffect(() => { rig.update({ cups: water?.cups ?? 0, onSetCups, tile: tileRef.current }); });
  useEffect(() => () => rig.dispose(), [rig]);
  // Escape closes an open bar with no change.
  useEffect(() => {
    if (!scrub) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") rig.machine.cancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scrub, rig]);

  if (!water) return <div className={styles.tile} role="status"><span className={styles.eyebrow}>Water</span>
    <span className={styles.meta}>Loading…</span></div>;

  const unit = water.unit ?? "cups";
  const shownPending = scrub?.pending ?? keyed;
  const level = fillFraction((scrub?.base ?? water.cups) + shownPending, water.goal);
  const summary = water.goal > 0 ? formatWaterOf(water.cups, water.goal, unit) : formatWater(water.cups, unit);
  const canScrub = Boolean(onSetCups && onAddCup);

  function addOne() {
    requestTiltPermission();
    if (keyed !== 0 && onSetCups) {
      const total = capped((water?.cups ?? 0) + keyed);
      setKeyed(0);
      setSplash((n) => n + 1);
      onSetCups(total);
      return;
    }
    onAddCup?.();
    setSplash((n) => n + 1);
  }

  return <>
    <motion.button ref={tileRef} type="button" className={`tap ${styles.tile}`} disabled={!onAddCup}
      aria-label={`Add ${stepPhrase(unit)} of water. ${summary}.`}
      aria-describedby={canScrub ? hintId : undefined}
      whileTap={reduce ? undefined : { scale: 0.97 }} transition={SPRINGS.snappy}
      onPointerDown={(e) => {
        suppressClick.current = false;
        if (!canScrub || (e.pointerType === "mouse" && e.button !== 0)) return;
        pressed.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        rig.press(e.clientX, e.clientY, water.cups);
      }}
      onPointerMove={(e) => rig.machine.move(e.clientX, e.clientY)}
      onPointerUp={() => {
        const outcome = rig.machine.up();
        if (pressed.current && outcome !== "tap") suppressClick.current = true;
        pressed.current = false;
      }}
      onPointerCancel={() => { pressed.current = false; rig.machine.cancel(); }}
      onLostPointerCapture={() => { if (rig.machine.phase !== "idle") rig.machine.cancel(); }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return; }
        addOne();
      }}
      onKeyDown={(e) => {
        suppressClick.current = false;
        if (!canScrub || scrub !== null) return;
        const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1
          : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
        if (delta !== 0) {
          e.preventDefault();
          setKeyed((k) => clampPending(k + delta, water.cups, MAX_CUPS));
        } else if (e.key === "Escape" && keyed !== 0) {
          e.preventDefault();
          setKeyed(0);
        }
      }}
      onBlur={() => setKeyed(0)}>
      <WaterLiquid level={level} tilt={tilt} animate={active && !reduce} />
      <span className={styles.eyebrow}>Water</span>
      <span className="relative flex items-baseline gap-1.5">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={waterValue(water.cups, unit)} className={styles.count}
            initial={reduce ? false : { y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0, transition: INSTANT } : { y: -16, opacity: 0, transition: FADES.quick }}
            transition={reduce ? INSTANT : SPRINGS.bouncy}>{waterNumber(water.cups, unit)}</motion.span>
        </AnimatePresence>
        <span className={styles.meta}>{water.goal > 0 ? `of ${formatWater(water.goal, unit)}`
          : unitWord(unit, waterValue(water.cups, unit))}</span>
      </span>
      <span className={`${styles.add} ${keyed !== 0 ? styles.pending : ""}`} aria-hidden="true">
        {keyed !== 0 ? `${formatWaterDelta(keyed, unit)} · Enter` : <>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          {stepLabel(unit)}
        </>}
      </span>
      {canScrub && <span id={hintId} className="sr-only">
        Hold and slide right to add more at once. Arrow keys choose an amount; Enter logs it.
      </span>}
      <span className="sr-only" role="status" aria-live="polite">
        {keyed !== 0 ? scrubText(water.cups, keyed, water.goal, unit) : ""}
      </span>
      {!reduce && <AnimatePresence>
        {splash > 0 && <motion.span key={splash} aria-hidden="true" className={styles.ripple}
          initial={{ scale: 0.2, opacity: 0.6 }} animate={{ scale: 2.4, opacity: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }} />}
      </AnimatePresence>}
    </motion.button>
    {typeof document !== "undefined" && createPortal(
      <AnimatePresence>
        {scrub && <motion.div key="scrub" className={styles.scrubLayer} style={{ top: scrub.top }}
          initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, y: 8, scale: 0.98, transition: FADES.quick }}
          transition={reduce ? INSTANT : SPRINGS.snappy}>
          <ScrubBar cups={scrub.base} goal={water.goal} pending={scrub.pending} unit={unit} />
        </motion.div>}
      </AnimatePresence>,
      document.body,
    )}
  </>;
}
