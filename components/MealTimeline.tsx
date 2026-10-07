"use client";

import { createPortal } from "react-dom";
import { quarterTime, TIMELINE_STEP, type TimelinePosition } from "./useMealReschedule";
import styles from "./MealTimeline.module.css";

export function timelineWave(distance: number): { indent: number; opacity: number; scale: number } {
  const d = Math.abs(distance);
  return {
    indent: Math.round(28 * Math.exp(-(d * d) / 12)),
    opacity: Math.max(0.28, 1 - d * 0.09),
    scale: Math.max(0.88, 1 - d * 0.015),
  };
}

export default function MealTimeline({ position, time, name }: { position: TimelinePosition; time: string; name: string }) {
  const [hours, minutes] = time.split(":").map(Number);
  const activeIndex = Math.round((hours * 60 + minutes) / 15);
  return createPortal(<div className={styles.overlay} data-meal-timeline aria-hidden="true">
    <div className={styles.heading}>Drag to set the time<span>Hold near an edge to keep scrolling · Release to save</span></div>
    <div className={styles.timeline}>
      {Array.from({ length: 96 }, (_, index) => {
        const label = quarterTime(index);
        const wave = timelineWave(index - activeIndex);
        return <div key={label} className={`${styles.row} ${label === time ? styles.selected : ""}`}
          style={{ top: position.offset + index * TIMELINE_STEP, left: 16 + wave.indent,
            opacity: wave.opacity, scale: wave.scale }}><span>{label}</span><i /></div>;
      })}
    </div>
    <div className={styles.preview} style={{ top: position.y }}><strong>{name}</strong><span>{time}</span></div>
    <div className={styles.footer}>15-minute steps</div>
  </div>, document.body);
}
