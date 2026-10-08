"use client";

import { motion, useReducedMotionConfig } from "motion/react";
import { INSTANT } from "@/lib/design/motion";
import { SproutFigure, type SproutPose } from "@/components/today/island/SproutFigure";

/** Polish pass (2026-10-07, "smooth Sprout's size transition"): `SproutFigure` renders at a plain
 *  inline `width`/`height` (components/today/island/SproutFigure.tsx, shared with the glass well —
 *  not this lane's file to change), so a beat change that moves Sprout between VISUAL-SPEC.md §2's
 *  three sizes (96/120/140/168) used to snap instantly even though every beat change around it
 *  (the stream card, the dock) already animates.
 *
 *  Fixed here, scoped to this onboarding-owned file, with a transform-only scale (motion-craft:
 *  "animate only transform and opacity," never width/height directly — that forces layout on every
 *  frame). `SproutFigure` always renders at `BASE_SIZE` (the largest size any beat uses, with
 *  headroom); a `motion.span` scales that fixed-size figure down to the beat's own size via
 *  `transform: scale()`, and the OUTER box — the one that actually participates in this guide's
 *  flex layout — animates in lockstep to the same target pixel size, so the two stay perfectly
 *  synchronized (scaled content exactly fills its box at every instant, never clipped, never
 *  leaving a gap) without the image itself reflowing. Same CONTAINER_ENTER timing the stream card
 *  and dock already use (0.24s, the house ease-out curve), so all three read as one coordinated
 *  move on a beat change, not three separate ones. */
const BASE_SIZE = 200;
const SIZE_EASE = [0.23, 1, 0.32, 1] as const;
const SIZE_TRANSITION = { duration: 0.24, ease: SIZE_EASE };

/**
 * Onboarding v2 (2026-10-07, lane L2): Sprout as the living listener and progress indicator for
 * the whole conversational flow — never a separate progress bar or ring.
 *
 * Swapped to the real `SproutFigure` (Sprout lane, landed on main, #484) from the interim
 * `SproutStage(figureOnly)` wrapper this named originally, per the orchestrator's go-ahead.
 * `SproutFigure` is purely presentational (no mood/vitality is read, nothing is stored, no tap
 * handler) — the `aria-live` text equivalent onboarding needs is rendered here, beside it, rather
 * than borrowed from `SproutStage`'s own status line.
 *
 * `listening`/`thinking`/`pointing` (VISUAL-SPEC.md §2's three onboarding-specific poses) landed on
 * main the same day (#486) — `OnboardingPose` is just `SproutPose` now; the fallback table this
 * file carried while they were still queued (§10) is gone with them.
 */
export type OnboardingPose = SproutPose;

export default function SproutGuide({ pose, line, size = 96 }: {
  pose: OnboardingPose;
  /** The one sentence a screen reader hears for this beat — the text equivalent for the pose,
   *  since `SproutFigure` itself carries no line of its own. */
  line: string;
  /** VISUAL-SPEC.md §2's three large-Sprout sizes (96/120/140/168) — the caller's own per-beat
   *  lookup, not derived from the pose (the same pose appears at different sizes across beats). */
  size?: number;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const transition = reduce ? INSTANT : SIZE_TRANSITION;
  return <span className="flex flex-col items-center">
    <motion.span data-sprout-guide-size={size} className="inline-flex items-center justify-center"
      style={{ overflow: "hidden" }}
      initial={false} animate={{ width: size, height: size }} transition={transition}>
      <motion.span className="inline-flex" style={{ transformOrigin: "50% 50%" }}
        initial={false} animate={{ scale: size / BASE_SIZE }} transition={transition}>
        <SproutFigure mood={pose} size={BASE_SIZE} priority />
      </motion.span>
    </motion.span>
    <span aria-live="polite" className="sr-only">{line}</span>
  </span>;
}
