"use client";

/**
 * The assistant at work (DESIGN.md §Motion › Thinking; owner, 2026-10-03: "a really cool animation
 * any time the AI is thinking, to show the user that something's going on and it's not frozen").
 *
 * Three harvest orbs (olive, sage, wheat) orbit and breathe inside an SVG goo filter, so they melt
 * together and part like one soft body, and a slow shimmer crosses the label. After `hintAfterMs`
 * a second line says the wait is expected, so a long answer never looks like a stalled screen.
 *
 * - `size="inline"` sits in a panel or sheet; `size="compact"` fits a chat bubble, a status chip or
 *   a button (there the hint takes the label's place, so the line never grows).
 * - Announced: `role="status"` with `aria-live="polite"`, the label and later the hint. Pass
 *   `announce={false}` inside a parent that is already the live region (a status chip), so the
 *   words are read once, by the parent.
 * - Reduced motion: one calm pulsing dot and still words; the orbs never turn.
 */

import { useEffect, useId, useState } from "react";
import { useReducedMotion } from "motion/react";
import styles from "./Thinking.module.css";

export const THINKING_HINT_MS = 6000;
export const THINKING_HINT = "Still working — this one takes a moment";

export type ThinkingSize = "inline" | "compact";

const ORBS = [
  { tone: styles.olive, r: 5.5 },
  { tone: styles.sage, r: 5 },
  { tone: styles.wheat, r: 4.5 },
] as const;

function Orbs({ filterId }: { filterId: string }) {
  return <svg className={styles.orbs} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <defs>
      {/* The goo: blur the orbs together, then cut the alpha back to a hard edge. */}
      <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
        <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 16 -6" />
      </filter>
    </defs>
    <g filter={`url(#${filterId})`}>
      {ORBS.map((orb, index) => <g key={index} className={styles.orbit}
        style={{ rotate: `${index * 120}deg` }}>
        <circle className={`${styles.orb} ${orb.tone}`} cx="24" cy="16" r={orb.r} />
      </g>)}
    </g>
  </svg>;
}

export default function Thinking({
  label, size = "inline", hint = THINKING_HINT, hintAfterMs = THINKING_HINT_MS, announce = true, className = "",
}: {
  label: string;
  size?: ThinkingSize;
  /** The line that appears once the wait runs long; `false` keeps the label alone. */
  hint?: string | false;
  hintAfterMs?: number;
  announce?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion() === true;
  const filterId = `thinking-goo-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (hint === false) return;
    const timer = setTimeout(() => setElapsed(true), hintAfterMs);
    return () => clearTimeout(timer);
  }, [hint, hintAfterMs]);

  const compact = size === "compact";
  const showHint = elapsed && hint !== false;
  const text = compact ? "text-tiny" : "text-caption";
  return <span role={announce ? "status" : undefined} aria-live={announce ? "polite" : undefined}
    data-thinking={size} data-motion={reduce ? "reduced" : "full"}
    className={[styles.root, compact ? styles.compact : styles.inline, reduce && styles.reduced, className]
      .filter(Boolean).join(" ")}>
    {reduce ? <span className={styles.dot} aria-hidden="true" /> : <Orbs filterId={filterId} />}
    <span className={styles.text}>
      {compact && showHint
        ? <span key="hint" data-thinking-hint="true" className={`${styles.hint} ${text}`}>{hint}</span>
        : <span className={`${styles.label} ${text} font-medium`}>{label}</span>}
      {!compact && showHint && <span data-thinking-hint="true" className={`${styles.hint} text-tiny`}>{hint}</span>}
    </span>
  </span>;
}
