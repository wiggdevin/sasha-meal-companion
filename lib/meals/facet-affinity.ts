/**
 * The facets rung of the occasion evidence ladder (Phase 17 O3, principle 2, D6):
 *
 *   explicit > the account's history > curated > facets v2 > neutral
 *
 * A facet only speaks for a food the curated table does not know (the curated answer's source is
 * "neutral"); a curated family, usual or never, always outranks it, and history (O2) outranks both.
 * It never lowers anything: a calibrated "typical" answer lifts a food to 0.60–0.85 (below a
 * curated usual's 1.0), and every weak or uncertain answer abstains, so the food stays at neutral
 * 0.5. A facet never speaks for an overnight ("other") slot or a slot with no known time.
 *
 * The server applies the calibration gate and the per-occasion threshold
 * (lib/server/occasion-facets.ts) and sends the mapped score in the snapshot as an occasion row
 * with source "facets"; the phone collects those into MealEvidence.facets (lib/meals/snapshot.ts)
 * and `affinity` places them on the ladder with `withFacetPrior`.
 *
 * Pure. No I/O.
 */

import type { Scored } from "@/lib/meals/affinity";
import type { Occasion } from "@/lib/meals/occasion";

/** lib/meals/affinity.ts NEUTRAL, restated so the two modules import each other only for types. */
const NEUTRAL = 0.5;

export const FACET_SCORE_MIN = 0.6;
export const FACET_SCORE_MAX = 0.85;
/**
 * D6: an uncertain answer is neutral. A probability promotes only when it clears both the
 * calibrated threshold and 0.5 + this margin, so p = 0.5 (and anything near it) is neutral at
 * every threshold, however low calibration put it.
 */
export const UNCERTAIN_MARGIN = 0.15;
export const FACET_PROMOTE_FLOOR = NEUTRAL + UNCERTAIN_MARGIN;

/**
 * A calibrated probability as an affinity score: null (abstain → neutral) below the effective
 * floor — the larger of the occasion's threshold and FACET_PROMOTE_FLOOR — or for an unusable
 * value; otherwise linear from FACET_SCORE_MIN at that floor to FACET_SCORE_MAX at certainty.
 */
export function facetOccasionScore(p: number | null | undefined, threshold: number): number | null {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return null;
  const floor = Math.max(threshold, FACET_PROMOTE_FLOOR);
  if (p < floor) return null;
  const lift = (p - floor) / (1 - floor);
  return round3(FACET_SCORE_MIN + (FACET_SCORE_MAX - FACET_SCORE_MIN) * lift);
}

/**
 * Places a facet score under the curated prior: it replaces only a neutral answer, is clamped to
 * [NEUTRAL, FACET_SCORE_MAX] so it can never penalise, and is ignored for "other" or an untimed slot.
 */
export function withFacetPrior(
  prior: Scored, facetScore: number | null | undefined, occasion: Occasion, untimed = false,
): Scored {
  if (prior.source !== "neutral" || untimed || occasion === "other") return prior;
  if (typeof facetScore !== "number" || !Number.isFinite(facetScore)) return prior;
  const score = Math.min(FACET_SCORE_MAX, Math.max(NEUTRAL, facetScore));
  return score > NEUTRAL ? { score, source: "facets" } : prior;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
