"use client";

import { useRef, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import styles from "@/components/today/DayCard.module.css";

export type DayFace = "calendar" | "overview";

/** Both faces, in the order the switch shows them. Both exist with or without a target revision. */
export const DAY_FACES: readonly DayFace[] = ["calendar", "overview"];

const LABEL: Record<DayFace, string> = { calendar: "Calendar", overview: "Overview" };

/**
 * The Day card's face switch (UI makeover §2.1, 2026-10-19). A recessed 44 px track split into two
 * equal segments, each always showing its word; the chosen one wears the olive lens, which rides
 * `SPRINGS.snappy` from one half to the other (instant under reduced motion). It is a tab list with
 * a roving tabindex: Arrow keys, Home and End move between faces.
 */
export default function FaceSwitch({ faces = DAY_FACES, active, onChange, reduce, panelId }: {
  faces?: readonly DayFace[]; active: DayFace; onChange: (face: DayFace) => void; reduce: boolean;
  /** Id prefix of the face panels this list controls (`${panelId}-${face}`). */
  panelId: string;
}) {
  const tabs = useRef(new Map<DayFace, HTMLButtonElement>());
  const index = Math.max(0, faces.indexOf(active));

  const onKeyDown = (event: KeyboardEvent, face: DayFace) => {
    const at = faces.indexOf(face);
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -at, End: faces.length - 1 - at }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = faces[(at + step + faces.length) % faces.length];
    onChange(next);
    // The tab is in view already; focusing it must never scroll the page under the card.
    tabs.current.get(next)?.focus({ preventScroll: true });
  };

  return <div role="tablist" aria-label="Day card views" className={styles.track}
    data-faces={faces.length}>
    {/* The lens is one segment wide; moving it by its own width lands it on the next segment. */}
    <motion.span aria-hidden="true" className={styles.switchLens} initial={false}
      animate={{ x: `${index * 100}%` }} transition={reduce ? INSTANT : SPRINGS.snappy} />
    {faces.map((face) => {
      const isActive = face === active;
      return <button key={face} type="button" role="tab" id={`${panelId}-tab-${face}`}
        ref={(el) => { if (el) tabs.current.set(face, el); else tabs.current.delete(face); }}
        aria-selected={isActive} aria-controls={`${panelId}-${face}`} tabIndex={isActive ? 0 : -1}
        data-active={isActive || undefined}
        className={styles.segment}
        onClick={() => onChange(face)} onKeyDown={(event) => onKeyDown(event, face)}>
        {LABEL[face]}
      </button>;
    })}
  </div>;
}
