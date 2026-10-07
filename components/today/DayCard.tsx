"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import FaceSwitch, { type DayFace } from "@/components/today/FaceSwitch";
import LiveWidget from "@/components/today/LiveWidget";
import DayOverview from "@/components/today/DayOverview";
import DayBoard, { type BoardData } from "@/components/today/DayBoard";
import { useFacesHeight } from "@/components/today/useDayCardMotion";
import { dayHeading } from "@/lib/today/calendar";
import { FADES, INSTANT, SPRINGS, SWAP } from "@/lib/design/motion";
import { selectionHaptic } from "@/lib/haptics";
import type { RebalancePanel } from "@/lib/rebalance/panel";
import type { OrbitBody, OrbitWater } from "@/lib/today/health-orbit";
import type { DayType, Macros, SlotId } from "@/lib/types";
import styles from "@/components/today/DayCard.module.css";

type Props = {
  /** The viewed day and today, ISO dates. */
  date: string;
  today: string;
  targets: Macros | null;
  consumed: Macros;
  /** The day holds a partly measured recipe serving (#21, `dayHasPartialNutrition`): the ledger and
   *  the overview say "at least" eaten and "at most" left. */
  partial?: boolean;
  /** The viewed day's type; training days wear the orange mark (DESIGN.md, Yellow, orange, red). */
  dayType?: DayType;
  water?: OrbitWater;
  onAddCup?: () => void;
  onSetCups?: (cups: number) => void;
  /** Phase 19 R2: the "Rebalance my day" panel and its one UI-owned link. */
  rebalance?: RebalancePanel;
  onOpenSlot?: (slot: SlotId) => void;
  /** The viewed day's shared body read for the orbit's activity and recovery entities. */
  body?: OrbitBody;
  /** The week strip (components/TodayDayStrip.tsx), which also grows the month. */
  calendar: ReactNode;
  board: BoardData;
};

/** How each face arrives and leaves: content blurs out of focus and the next comes into it, never a
 *  cut. */
function faceAnimation(self: DayFace, face: DayFace, reduce: boolean) {
  const shown = self === face;
  if (reduce) return { animate: shown ? { opacity: 1 } : { opacity: 0 }, transition: INSTANT };
  if (shown) return { animate: SWAP.shown, transition: { ...FADES.base, duration: 0.3, delay: 0.02 } };
  return { animate: SWAP.hidden, transition: FADES.quick };
}

/**
 * The Day card (2026-10-01, docs/decisions/2026-10-01-liquid-day-card-rulings.md): one card with
 * three faces where Today used to stack a calendar card and a second overview card.
 * - Calendar: the week strip (double-tap grows the month) over the live widget, a charcoal floor
 *   under a glass lid whose panels the user chooses and swipes (components/today/LiveWidget.tsx,
 *   2026-10-05; it replaced the ledger tab).
 * - Overview: glass wells for calories, the macros, water, active burn and recovery
 *   (components/today/DayOverview.tsx, 2026-10-05; it replaced the health orbit and its orb).
 * - Board: the next meal, water, a tip, this week, and explainers.
 * The face switch in the header moves between all three; the faces box springs its height from the
 * face it had to the one it has (components/today/useDayCardMotion.ts).
 */
export default function DayCard({ date, today, targets, consumed, partial = false, dayType, water, onAddCup, onSetCups, rebalance, onOpenSlot, body, calendar, board }: Props) {
  const reduce = useReducedMotionConfig() ?? false;
  const panelId = useId();
  const faces: DayFace[] = targets ? ["calendar", "overview", "board"] : ["calendar", "board"];
  const [face, setFace] = useState<DayFace>("calendar");
  // Targets can go away (a revision being rebuilt): the overview goes with them, so the card falls
  // back to its calendar rather than showing a face it no longer has.
  if (!targets && face === "overview") setFace("calendar");
  const facesRef = useRef<HTMLDivElement | null>(null);
  const lockedFrom = useRef<number | null>(null);
  const settledFace = useRef<DayFace>("calendar");
  const facesBox = useFacesHeight(facesRef);
  const heading = dayHeading(date, today);

  function switchFace(next: DayFace) {
    if (next === face) return;
    lockedFrom.current = facesBox.height.get();
    setFace(next);
    selectionHaptic();
  }

  // Each face change springs the card's height. Runs before paint, so the old height never flashes.
  useLayoutEffect(() => {
    if (settledFace.current === face) return;
    settledFace.current = face;
    const start = lockedFrom.current;
    lockedFrom.current = null;
    const end = facesBox.measure();
    if (start === null) return;
    void facesBox.spring(start, end, { delay: 0, reduce });
    // Runs once per face change; everything else is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [face]);

  const facePanel = (self: DayFace, children: ReactNode) => {
    const active = self === face;
    const motionProps = faceAnimation(self, face, reduce);
    return <motion.div key={self} id={`${panelId}-${self}`} role="tabpanel" aria-labelledby={`${panelId}-tab-${self}`}
      className={styles.face} data-active={active || undefined} data-face={self}
      inert={!active} aria-hidden={active ? undefined : true}
      initial={false} {...motionProps}>
      {children}
    </motion.div>;
  };
  const panelData = targets ? { targets, consumed, partial, water, onAddCup, rebalance, onOpenSlot } : null;

  return (
    <section className={`shell ${styles.card}`} aria-label="Day" data-face={face}>
      <div className={`surface ${styles.surface}`}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={date} className="min-w-0"
                initial={reduce ? false : { opacity: 0, y: 8, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, y: -8, filter: "blur(4px)", transition: FADES.quick }}
                transition={reduce ? INSTANT : SPRINGS.snappy}>
                <div className={styles.titleRow}>
                  <h2 className={styles.title}>{heading.title}</h2>
                  {dayType && <span className={styles.dayType} data-day-type={dayType === "rest" ? "rest" : "training"}>
                    {dayType === "rest" ? "Rest" : "Training"}
                  </span>}
                </div>
                <p className={styles.subtitle}>
                  <span className={styles.subtitleFull}>{heading.subtitle}</span>
                  <span className={styles.subtitleShort}>{heading.short}</span>
                </p>
              </motion.div>
            </AnimatePresence>
          </div>
          <FaceSwitch faces={faces} active={face} onChange={switchFace} reduce={reduce} panelId={panelId} />
        </header>
        <div ref={facesRef} className={styles.faces}>
          {facePanel("calendar", <>
            {calendar}
            {panelData ? <LiveWidget data={panelData} paused={face !== "calendar"}
              when={date === today ? "today" : date < today ? "past" : "future"} /> : <div className={styles.profile}>
              <div className="flex min-w-0 flex-col gap-0.5">
                <h3 className="m-0 text-[16px] font-medium text-charcoal">Finish your profile</h3>
                <p className="m-0 text-caption text-muted">Add your details to get daily targets.</p>
              </div>
              {/* A link, so it wears the primary recipe (Button renders only <button>); it says its verb. */}
              <a href="/settings" className={buttonClasses({ variant: "primary", className: "shrink-0" })}>Set up</a>
            </div>}
          </>)}
          {panelData && facePanel("overview", <DayOverview data={panelData} body={body} />)}
          {facePanel("board", <DayBoard {...board} date={date} today={today} dayType={dayType} water={water} onAddCup={onAddCup}
            onSetWater={board.onSetWater ?? onSetCups} active={face === "board"} enterDelay={0} />)}
        </div>
      </div>
    </section>
  );
}
