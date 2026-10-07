/**
 * The calibration gate for v2 occasion facets (Phase 17 O3, D6/D7, Acceptance 9).
 *
 * Jev's `breakfast_fit` … `snack_fit` judgments (rubric v2, lib/foods/facet-questions.ts) reach the
 * meal ranking only when a stored calibration report passes: on a human-labelled, cuisine-diverse
 * holdout (scripts/eval/facets-occasion.holdout.json), the plates the ranking generates for every
 * cuisine reach at least 85 % plausibility against human labels, and no cuisine is more than 10
 * points below the best. Label accuracy is reported beside it, not gated. The
 * billed eval (scripts/eval/facets-occasion-eval.ts --live --freeze) writes the report's numbers
 * and per-occasion thresholds into lib/foods/occasion-calibration.data.ts; a failing report writes
 * `null`. The default is `null`: abstain.
 *
 * The gate re-checks the stored numbers rather than trusting a `passes` flag, and refuses a report
 * for another rubric revision, an unreviewed seed holdout, a missing cuisine or a thin sample.
 *
 * Pure. No I/O.
 */

import {
  OCCASION_RUBRIC_VERSION, type OccasionFacet,
} from "@/lib/foods/facet-vocabulary";
import { OCCASION_CALIBRATION } from "@/lib/foods/occasion-calibration.data";

export const CALIBRATION_CUISINES = [
  "south-asian", "east-asian", "latin-american", "mediterranean", "north-american-european",
  "west-african",
] as const;
export type CalibrationCuisine = (typeof CALIBRATION_CUISINES)[number];

/** The occasions a facet speaks to. An overnight ("other") slot has none and stays neutral. */
export const MEAL_OCCASIONS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealOccasion = (typeof MEAL_OCCASIONS)[number];

export const OCCASION_FACET_OF: Readonly<Record<MealOccasion, OccasionFacet>> = {
  breakfast: "breakfast_fit", lunch: "lunch_fit", dinner: "dinner_fit", snack: "snack_fit",
};

/** Acceptance 9, plus the smallest sample a per-cuisine number may stand on. */
export const ACCEPTANCE = {
  minPerCuisine: 0.85,
  maxGapBelowBest: 0.10,
  minPairsPerCuisine: 20,
  minPlatesPerCuisine: 8,
} as const;

export type CuisineScore = {
  /**
   * Acceptance 9, the gated number: share of GENERATED plates (lib/meals rankPlates over the
   * cuisine's labelled pantry, facets on the ladder) that the human labels find plausible.
   */
  plausibility: number;
  /** Secondary, reported only: labelled (item, occasion) pairs predicted correctly. */
  accuracy: number;
  /** Secondary, reported only: the same over named dishes. */
  dishAccuracy: number;
  pairs: number;
  plates: number;
};

export type StoredOccasionCalibration = {
  rubricVersion: number;
  model: string;
  measuredAt: string;
  holdoutSha256: string;
  /** False for the seed set until the owner reviews its labels; the gate stays shut while false. */
  holdoutReviewed: boolean;
  /** Per-occasion probability at or above which a facet promotes a food (else neutral). */
  thresholds: Readonly<Record<MealOccasion, number>>;
  perCuisine: Readonly<Record<CalibrationCuisine, CuisineScore>>;
};

export type OccasionGate =
  | { open: false; reason: string }
  | { open: true; rubricVersion: number; calibrationId: string;
    thresholds: Readonly<Record<MealOccasion, number>> };

/** Acceptance 9 over per-cuisine scores. Shared by the eval (to write) and the gate (to read). */
export function calibrationVerdict(
  perCuisine: Readonly<Partial<Record<CalibrationCuisine, CuisineScore>>>,
): { passes: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const present = CALIBRATION_CUISINES.filter((cuisine) => perCuisine[cuisine]);
  for (const cuisine of CALIBRATION_CUISINES) {
    const score = perCuisine[cuisine];
    if (!score) {
      reasons.push(`${cuisine}: not measured`);
      continue;
    }
    if (![score.accuracy, score.plausibility, score.dishAccuracy].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
      reasons.push(`${cuisine}: malformed score`);
      continue;
    }
    if (!Number.isSafeInteger(score.pairs) || !Number.isSafeInteger(score.plates)
      || score.pairs < 0 || score.plates < 0) {
      reasons.push(`${cuisine}: malformed sample counts`);
      continue;
    }
    if (score.pairs < ACCEPTANCE.minPairsPerCuisine) reasons.push(`${cuisine}: only ${score.pairs} labelled pairs`);
    if (score.plates < ACCEPTANCE.minPlatesPerCuisine) {
      reasons.push(`${cuisine}: only ${score.plates} generated plates`);
    }
    if (score.plausibility < ACCEPTANCE.minPerCuisine) {
      reasons.push(`${cuisine}: plate plausibility ${pct(score.plausibility)} < 85 %`);
    }
  }
  for (const metric of ["plausibility"] as const) {
    const values = present.map((cuisine) => perCuisine[cuisine]![metric]).filter(Number.isFinite);
    if (values.length === 0) continue;
    const best = Math.max(...values);
    for (const cuisine of present) {
      const gap = best - perCuisine[cuisine]![metric];
      // A hair of float slack so an exact 10-point gap passes, as the spec intends.
      if (gap > ACCEPTANCE.maxGapBelowBest + 1e-9) {
        reasons.push(`${cuisine}: ${metric} ${pct(gap)} below the best cuisine (> 10 points)`);
      }
    }
  }
  return { passes: reasons.length === 0, reasons };
}

/** Whether v2 occasion facets may feed the ranking, and at which thresholds. */
export function occasionFacetGate(
  calibration: StoredOccasionCalibration | null = OCCASION_CALIBRATION,
): OccasionGate {
  if (!calibration) return { open: false, reason: "no stored calibration report" };
  if (calibration.rubricVersion !== OCCASION_RUBRIC_VERSION) {
    return { open: false, reason: `calibration is for rubric v${calibration.rubricVersion}` };
  }
  if (!calibration.holdoutReviewed) return { open: false, reason: "holdout labels not reviewed by the owner" };
  for (const occasion of MEAL_OCCASIONS) {
    const threshold = calibration.thresholds?.[occasion];
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
      return { open: false, reason: `no usable ${occasion} threshold` };
    }
  }
  const verdict = calibrationVerdict(calibration.perCuisine ?? {});
  if (!verdict.passes) return { open: false, reason: verdict.reasons[0] ?? "calibration fails" };
  return {
    open: true,
    rubricVersion: calibration.rubricVersion,
    calibrationId: `${calibration.rubricVersion}:${calibration.model}:${calibration.holdoutSha256.slice(0, 12)}:${calibration.measuredAt}`,
    thresholds: { ...calibration.thresholds },
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}
