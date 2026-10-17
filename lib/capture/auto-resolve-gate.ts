/**
 * When a photo, label or typed capture may pick its catalog match without asking (W125, T3). The
 * owner's ruling (2026-10-17, docs/decisions/2026-10-17-capture-auto-resolve-gate.md): the
 * conservative option. A capture auto-resolves only at high confidence; anything less shows the
 * choices and asks.
 *
 * This is the one place to change that. The search eval (`scripts/search-eval.ts`) still writes
 * its own measured thresholds into `lib/search/thresholds.ts`; a capture must clear BOTH, so a
 * rerun that loosens the eval's pair never loosens capture. Raise `minScore` or `minMargin` here to
 * ask more often, lower them to ask less. Pure.
 */
import { AUTO_RESOLVE, shouldAutoResolve } from "@/lib/search/thresholds";

/** The capture floor: the top match's score, and its lead over the second, both on a 0–1 scale. */
export const CAPTURE_AUTO_RESOLVE = { minScore: 0.95, minMargin: 0.3 } as const;

/** True only when the eval's thresholds AND the capture floor both say the top hit is certain. */
export function captureAutoResolves(hits: { score: number }[], cls: keyof typeof AUTO_RESOLVE): boolean {
  if (!shouldAutoResolve(hits, cls)) return false; // also refuses fewer than two hits
  return hits[0].score >= CAPTURE_AUTO_RESOLVE.minScore
    && hits[0].score - hits[1].score >= CAPTURE_AUTO_RESOLVE.minMargin;
}
