"use client";

import { SproutFigure, type SproutPose } from "@/components/today/island/SproutFigure";

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
  return <span className="flex flex-col items-center">
    <SproutFigure mood={pose} size={size} priority />
    <span aria-live="polite" className="sr-only">{line}</span>
  </span>;
}
