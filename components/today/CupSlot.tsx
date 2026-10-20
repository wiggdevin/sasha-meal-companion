"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import { selectionHaptic } from "@/lib/haptics";
import type { OrbitWater } from "@/lib/today/health-orbit";
import { guardSelection, MAX_CUPS } from "@/lib/today/water-gesture";
import { clampPending, createWaterScrub, scrubParts, scrubText } from "@/lib/today/water-scrub";
import { formatWater, formatWaterDelta, formatWaterOf, stepPhrase, waterNumber, type WaterUnit } from "@/lib/water-units";
import styles from "@/components/today/CupSlot.module.css";

/**
 * The one accessible water name on the Day card: "Add a cup of water. 4 of 8 cups.", in the
 * account's unit ("Add 8 oz of water. 32 of 128 oz."); the goal only when there is one, and no
 * amount while the day's water is still loading.
 */
export function cupName(water: OrbitWater | undefined): string {
  if (!water) return "Add a cup of water.";
  const unit = water.unit ?? "cups";
  const cups = Math.max(0, water.cups);
  const summary = water.goal > 0 ? formatWaterOf(cups, water.goal, unit) : formatWater(cups, unit);
  return `Add ${stepPhrase(unit)} of water. ${summary}.`;
}

type Props = {
  water?: OrbitWater;
  /** Adds one stored cup. */
  onAddCup?: () => void;
  /** The day's new total in cups, written once (the scrub and the keyboard amount). */
  onSetCups?: (cups: number) => void;
};

type Scrub = { pending: number; top: number; base: number };

const capped = (cups: number) => Math.min(MAX_CUPS, Math.max(0, cups));

/** Under the pill: the cup sits in the card's first row, near the top of the screen. */
function barTop(pill: HTMLElement | null): number {
  const rect = pill?.getBoundingClientRect();
  return rect ? rect.bottom + 12 : 16;
}

function ScrubBar({ cups, goal, pending, unit }: { cups: number; goal: number; pending: number; unit: WaterUnit }) {
  const total = Math.max(0, cups + pending);
  const scale = Math.max(goal, cups, total, 1);
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;
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

/** A droplet that fills to the day's share of the goal (empty with no goal, full at or past it). */
function Droplet({ share }: { share: number }) {
  const clip = `cup-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const DROP = "M10 1.5C10 1.5 3.5 9 3.5 13.2a6.5 6.5 0 0 0 13 0C16.5 9 10 1.5 10 1.5Z";
  const top = 21 - 19 * Math.max(0, Math.min(1, share));
  return <svg className={styles.drop} width="20" height="22" viewBox="0 0 20 22" aria-hidden="true" focusable="false">
    <defs><clipPath id={clip}><path d={DROP} /></clipPath></defs>
    <rect className={styles.dropFill} x="0" y={top.toFixed(2)} width="20" height="22" clipPath={`url(#${clip})`} />
    <path className={styles.dropLine} d={DROP} />
  </svg>;
}

/**
 * The Day card's cup (UI makeover §4, header row 1, on both faces): one 44 px pill, a droplet that
 * fills with the gauge's water, the day's "4/8" in the account's unit, and a plus.
 *
 * - A tap adds one step: 8 oz, a cup or 237 ml, which is one stored cup.
 * - Hold about a third of a second and slide: a bar opens under the pill and counts in the account's
 *   unit, faster the farther right the finger goes (lib/today/water-scrub.ts). Letting go writes the
 *   new total once through `onSetCups`; letting go at zero, or Escape, changes nothing. The total is
 *   the count the bar opened on plus the amount slid, capped at MAX_CUPS: a sync that lands mid-slide
 *   does not move the base under the finger.
 * - Keyboard: the arrow keys choose a pending amount, Enter logs it, Escape drops it. The arrows do
 *   nothing while a slide is open, and opening or finishing a slide drops any keyed amount.
 * - A press that moves before the hold matures is a scroll, never a cup. Nothing asks for the
 *   motion sensor.
 */
export default function CupSlot({ water, onAddCup, onSetCups }: Props) {
  const reduce = useReducedMotionConfig() ?? false;
  const hintId = useId();
  const pillRef = useRef<HTMLButtonElement>(null);
  const [scrub, setScrub] = useState<Scrub | null>(null);
  const [keyed, setKeyed] = useState(0);
  // A lift that ended a hold or an abandoned press must not also count as the pill's click.
  const suppressClick = useRef(false);
  const pressed = useRef(false);
  // Built once; it reads the latest props through a holder an effect keeps current, so a re-render
  // never rebuilds the machine mid-hold.
  const [rig] = useState(() => {
    const latest: { onSetCups?: (cups: number) => void; pill: HTMLElement | null } = { pill: null };
    // The count the press started on: the bar was clamped against it, so the commit adds to it.
    let base = 0;
    let release: (() => void) | null = null;
    const close = () => { release?.(); release = null; setScrub(null); };
    const machine = createWaterScrub({
      onHold: () => {
        release = guardSelection(document);
        setKeyed(0);
        setScrub({ pending: 0, top: barTop(latest.pill), base });
        selectionHaptic();
      },
      onStep: (pending) => { setScrub((s) => (s ? { ...s, pending } : s)); selectionHaptic(); },
      onCommit: (pending) => { close(); setKeyed(0); latest.onSetCups?.(capped(base + pending)); },
      onCancel: close,
    });
    return {
      machine,
      press(x: number, y: number, cups: number) { base = cups; machine.down(x, y, cups, MAX_CUPS); },
      update(next: typeof latest) { Object.assign(latest, next); },
      dispose() { machine.cancel(); release?.(); release = null; },
    };
  });
  useEffect(() => { rig.update({ onSetCups, pill: pillRef.current }); });
  useEffect(() => () => rig.dispose(), [rig]);
  // Escape closes an open bar with no change.
  useEffect(() => {
    if (!scrub) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") rig.machine.cancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scrub, rig]);

  const unit = water?.unit ?? "cups";
  const cups = water?.cups ?? 0;
  const goal = water?.goal ?? 0;
  const canScrub = Boolean(water && onSetCups && onAddCup);
  const shown = (scrub?.base ?? cups) + (scrub?.pending ?? keyed);

  function addOne() {
    if (keyed !== 0 && onSetCups) {
      const total = capped(cups + keyed);
      setKeyed(0);
      onSetCups(total);
      return;
    }
    onAddCup?.();
  }

  return <>
    <motion.button ref={pillRef} type="button" className={`tap ${styles.pill}`} disabled={!water || !onAddCup}
      data-keyed={keyed !== 0 || undefined}
      aria-label={cupName(water)} aria-describedby={canScrub ? hintId : undefined}
      whileTap={reduce ? undefined : { scale: 0.96 }} transition={SPRINGS.snappy}
      onPointerDown={(e) => {
        suppressClick.current = false;
        if (!canScrub || (e.pointerType === "mouse" && e.button !== 0)) return;
        pressed.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        rig.press(e.clientX, e.clientY, cups);
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
          setKeyed((k) => clampPending(k + delta, cups, MAX_CUPS));
        } else if (e.key === "Escape" && keyed !== 0) {
          e.preventDefault();
          setKeyed(0);
        }
      }}
      onBlur={() => setKeyed(0)}>
      <Droplet share={goal > 0 ? shown / goal : 0} />
      <span className={styles.count} aria-hidden="true">
        {!water ? "Water" : keyed !== 0 ? formatWaterDelta(keyed, unit)
          : <>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={cups} className={styles.now}
                initial={reduce ? false : { y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
                exit={reduce ? { opacity: 0, transition: INSTANT } : { y: -10, opacity: 0, transition: FADES.quick }}
                transition={reduce ? INSTANT : SPRINGS.bouncy}>{waterNumber(cups, unit)}</motion.span>
            </AnimatePresence>
            {goal > 0 && <span className={styles.goal}>/{waterNumber(goal, unit)}</span>}
          </>}
      </span>
      <span className={styles.plus} aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </span>
      {canScrub && <span id={hintId} className="sr-only">
        Hold and slide right to add more at once. Arrow keys choose an amount; Enter logs it.
      </span>}
      <span className="sr-only" role="status" aria-live="polite">
        {keyed !== 0 ? scrubText(cups, keyed, goal, unit) : ""}
      </span>
    </motion.button>
    {typeof document !== "undefined" && createPortal(
      <AnimatePresence>
        {scrub && <motion.div key="scrub" className={styles.scrubLayer} style={{ top: scrub.top }}
          initial={reduce ? false : { opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, y: -8, scale: 0.98, transition: FADES.quick }}
          transition={reduce ? INSTANT : SPRINGS.snappy}>
          <ScrubBar cups={scrub.base} goal={goal} pending={scrub.pending} unit={unit} />
        </motion.div>}
      </AnimatePresence>,
      document.body,
    )}
  </>;
}
