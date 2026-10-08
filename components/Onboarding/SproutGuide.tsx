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
 *  Fixed here, scoped to this onboarding-owned file, with a genuinely transform-only scale: the
 *  outer box is a STATIC `BASE_SIZE` square (168 — VISUAL-SPEC.md §2's own largest size, the
 *  opener's "wave" beat; no extra headroom: ui-ux-buddy's Sonnet lane caught a 200px first pass
 *  leaving ~52px of dead space around a 96px beat, working against the same empty-middle fix this
 *  pass is for) that
 *  never itself animates width/height — only its child's `transform: scale()` changes, so this
 *  never forces layout on a frame (an earlier version of this fix animated the outer box's
 *  width/height too, which ui-ux-buddy's Sonnet lane correctly flagged: that still forces layout
 *  every frame despite the comment's "transform-only" claim, and its `overflow: hidden` clipped
 *  `SproutFigure`'s own contact shadow and breathe animation at the box edge — both gone now that
 *  the box never changes size and nothing needs clipping). The outer box's reserved layout space
 *  is therefore the same `BASE_SIZE` for every beat; `.stream`'s own centering (this polish pass's
 *  empty-middle fix) absorbs that, same as it already absorbs every other beat-to-beat height
 *  difference. Same CONTAINER_ENTER timing the stream card and dock already use (0.24s, the house
 *  ease-out curve already established for this shell's generative containers — see
 *  ConversationalOnboarding.tsx's own `CONTAINER_EASE`, `app/globals.css`'s `.morphing-dock` — so
 *  Sprout's resize reads as the same coordinated move, not a fourth, different one. */
const BASE_SIZE = 168;
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
    <span data-sprout-guide-size={size} className="inline-flex items-center justify-center"
      style={{ width: BASE_SIZE, height: BASE_SIZE }}>
      <motion.span className="inline-flex" style={{ transformOrigin: "50% 50%" }}
        initial={false} animate={{ scale: size / BASE_SIZE }} transition={transition}>
        <SproutFigure mood={pose} size={BASE_SIZE} priority />
      </motion.span>
    </span>
    <span aria-live="polite" className="sr-only">{line}</span>
  </span>;
}
