"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import FaceSwitch, { DAY_FACES, type DayFace } from "@/components/today/FaceSwitch";
import CalendarFace from "@/components/today/CalendarFace";
import CupSlot from "@/components/today/CupSlot";
import OverviewFace, { type CockpitData } from "@/components/today/overview/OverviewFace";
import { CardToneContext } from "@/components/ui/CardFrame";
import { useFacesHeight } from "@/components/today/useDayCardMotion";
import { FADES, INSTANT, SWAP } from "@/lib/design/motion";
import { selectionHaptic } from "@/lib/haptics";
import styles from "@/components/today/DayCard.module.css";

const DAY_CARD_TONE = { depth: 0, face: "raised" } as const;

type Props = {
  /** The week strip (components/TodayDayStrip.tsx), which also grows the month. */
  calendar: ReactNode;
  /** Everything the card shows about the viewed day (components/today/overview/types.ts), plus the
   *  cockpit's eaten count (components/today/overview/OverviewFace.tsx). */
  overview: CockpitData;
};

/** The face every load opens on. The face is never stored. */
const DEFAULT_FACE: DayFace = "overview";

/** How each face arrives and leaves: content blurs out of focus and the next comes into it, never a
 *  cut. */
function faceAnimation(self: DayFace, face: DayFace, reduce: boolean) {
  const shown = self === face;
  if (reduce) return { animate: shown ? { opacity: 1 } : { opacity: 0 }, transition: INSTANT };
  if (shown) return { animate: SWAP.shown, transition: { ...FADES.base, duration: 0.3, delay: 0.02 } };
  return { animate: SWAP.hidden, transition: FADES.quick };
}

/**
 * The Day card (UI makeover §2.1, 2026-10-19; first built 2026-10-01,
 * docs/decisions/2026-10-01-liquid-day-card-rulings.md): one card, two faces, with or without a
 * target revision.
 * - Header, row 1: the viewed day's Rest/Training pill and the cup (CupSlot), on both faces.
 *   Row 2: the full-width face switch. The viewed date is the page's title, not the card's.
 * - Calendar (CalendarFace): the week strip, which also grows the month, and the day's line.
 * - Overview (OverviewFace), the face every load opens on: the day's summary, next meal, rebalance,
 *   companion and week.
 * Both faces stay mounted; the hidden one is inert and hidden from assistive tech. The faces box
 * springs its height from the face it had to the one it has (components/today/useDayCardMotion.ts),
 * at once under reduced motion.
 */
export default function DayCard({ calendar, overview }: Props) {
  const reduce = useReducedMotionConfig() ?? false;
  const panelId = useId();
  const [face, setFace] = useState<DayFace>(DEFAULT_FACE);
  const facesRef = useRef<HTMLDivElement | null>(null);
  const lockedFrom = useRef<number | null>(null);
  const settledFace = useRef<DayFace>(DEFAULT_FACE);
  const facesBox = useFacesHeight(facesRef);
  const { dayType, water, onAddCup, onSetCups } = overview;

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

  return (
    <section className={`shell ${styles.card}`} aria-label="Day" data-face={face}>
      <div className={`surface ${styles.surface}`}>
        <header className={styles.header}>
          <div className={styles.headerRow}>
            {dayType && <span className={styles.dayType} data-day-type={dayType === "rest" ? "rest" : "training"}>
              {dayType === "rest" ? "Rest" : "Training"}
            </span>}
            <div className={styles.cup}>
              <CupSlot water={water} onAddCup={onAddCup} onSetCups={onSetCups} />
            </div>
          </div>
          <FaceSwitch faces={DAY_FACES} active={face} onChange={switchFace} reduce={reduce} panelId={panelId} />
        </header>
        {/* The card is a raised frame on the ground, so a CardFrame inside it takes the inset step. */}
        <CardToneContext.Provider value={DAY_CARD_TONE}>
          <div ref={facesRef} className={styles.faces}>
            {facePanel("calendar", <CalendarFace calendar={calendar} data={overview} active={face === "calendar"} />)}
            {facePanel("overview", <OverviewFace data={overview} active={face === "overview"} />)}
          </div>
        </CardToneContext.Provider>
      </div>
    </section>
  );
}
