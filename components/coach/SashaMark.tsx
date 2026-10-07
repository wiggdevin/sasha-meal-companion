"use client";

/**
 * The assistant's living mark (U21, 2026-10-04; owner: "give [the assistant] some kind of AI feel and maybe
 * some kind of movement, some animation … some kind of thinking state, like an animated thinking
 * state"). The same three harvest orbs as `components/ui/Thinking.tsx`, in the same goo, so the mark
 * and the transcript's thinking line read as one presence: at rest they drift and breathe slowly;
 * while a turn is in flight the same loops run three times faster. The speed changes through
 * `playbackRate`, so the orbs speed up from where they are instead of jumping to a new frame.
 * Reduced motion: the orbs sit still, the mark is a still emblem.
 */
import { useEffect, useId, useRef } from "react";
import { useReducedMotion } from "motion/react";
import styles from "./CoachHeader.module.css";

/* Larger orbs on a tighter orbit than Thinking's, and a lighter goo, so at 28–32 px three bodies
   still read as three (Kimi audit 2026-10-04: at the full goo they merged into one smudge). */
const ORBS = [
  { tone: styles.olive, r: 5 },
  { tone: styles.sage, r: 4.5 },
  { tone: styles.wheat, r: 4 },
] as const;

/** How much faster the orbs move while the assistant works. */
export const THINKING_RATE = 3;

export default function SashaMark({ thinking = false, size = 32 }: { thinking?: boolean; size?: number }) {
  const reduce = useReducedMotion() === true;
  const filterId = `assistant-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const animations = svg.current?.getAnimations?.({ subtree: true }) ?? [];
    for (const animation of animations) animation.updatePlaybackRate(thinking ? THINKING_RATE : 1);
  }, [thinking, reduce]);
  return <span className={styles.mark} data-thinking={thinking ? "true" : undefined}
    data-motion={reduce ? "reduced" : "full"} aria-hidden="true">
    <svg ref={svg} className={styles.orbs} width={size} height={size} viewBox="0 0 32 32" focusable="false">
      <defs>
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 12 -5" />
        </filter>
      </defs>
      <g filter={`url(#${filterId})`}>
        {ORBS.map((orb, index) => <g key={index} className={styles.orbit} style={{ rotate: `${index * 120}deg` }}>
          <circle className={`${styles.orb} ${orb.tone}`} cx="22.5" cy="16" r={orb.r} />
        </g>)}
      </g>
    </svg>
  </span>;
}
