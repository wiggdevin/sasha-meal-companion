/**
 * Pure scoring for the occasion-rubric calibration eval (Phase 17 O3, Acceptance 9). No I/O, no
 * model call: scripts/eval/facets-occasion-eval.ts feeds it Jev's answers, and
 * tests/foods/occasion-calibration.test.ts feeds it fake ones.
 *
 *  - An observation is one labelled (item, occasion) pair with Jev's probability. A null label
 *    (practice genuinely mixed) is not scored.
 *  - A prediction is "typical" when the production mapping promotes it (p ≥ the occasion's
 *    threshold and ≥ 0.65, so an uncertain 0.5 never is); anything else abstains (neutral, never a
 *    penalty), which counts as "not typical" here.
 *  - The threshold per occasion is the one that maximises balanced accuracy, (TPR + TNR) / 2, over
 *    a 0.01 grid from 0.65 (the promote floor) to 0.99; on a tied run, the middle of the highest run (widest margin, upper middle).
 *  - Per-cuisine numbers are leave-one-cuisine-out: a cuisine is scored at thresholds chosen
 *    without it, so no cuisine grades its own tuning.
 *  - plausibility (Acceptance 9, what the gate reads) is over GENERATED plates: for each cuisine
 *    the plate generator (./plates.ts: lib/meals rankPlates over that cuisine's labelled pantry as
 *    Eats, with Jev's facet scores on the ladder) builds plates at every occasion, and a rule-based
 *    judge scores each against the human labels: a plate is plausible at an occasion when no food
 *    on it is labelled false (not typical) there. accuracy (all labelled pairs) and dishAccuracy
 *    (named dishes only) are secondary, reported, not gated.
 */

import { createHash } from "node:crypto";
import type { FacetFoodInput } from "@/lib/foods/facet-keys";
import { OCCASION_RUBRIC_VERSION } from "@/lib/foods/facet-vocabulary";
import { facetOccasionScore } from "@/lib/meals/facet-affinity";
import {
  CALIBRATION_CUISINES, calibrationVerdict, MEAL_OCCASIONS, type CalibrationCuisine, type CuisineScore,
  type MealOccasion, type StoredOccasionCalibration,
} from "@/lib/foods/occasion-gate";

export type Label = boolean | null;
export type HoldoutItem = {
  id: string;
  cuisine: CalibrationCuisine;
  kind: "food" | "dish";
  food: FacetFoodInput;
  labels: Record<MealOccasion, Label>;
};
/** A labelled component the plate generator may put on a plate. Macros per 100 g. */
export type PantryItem = Omit<HoldoutItem, "kind"> & {
  role: "protein" | "carb" | "fat";
  per100g: { protein: number; carbs: number; fat: number };
};
export type Holdout = {
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  items: HoldoutItem[];
  pantry: PantryItem[];
};
/** One generated plate: the pantry item ids on it, at an occasion. */
export type GeneratedPlate = { occasion: MealOccasion; foodIds: string[] };
/** Facet affinity per pantry item id, as the ranking ladder receives it (already gated/mapped). */
export type FacetScores = Record<string, Partial<Record<MealOccasion, number>>>;
/** Builds plates from one cuisine's pantry at one occasion. Pure; the real one is ./plates.ts. */
export type PlateGenerator = (
  pantry: readonly PantryItem[], occasion: MealOccasion, facets: FacetScores,
) => GeneratedPlate[];
/** Jev's probability per item id and occasion. */
export type Answers = Record<string, Partial<Record<MealOccasion, number>>>;
export type Observation = {
  id: string; cuisine: CalibrationCuisine; dish: boolean; occasion: MealOccasion; truth: boolean; p: number;
};
export type Thresholds = Record<MealOccasion, number>;

export type CalibrationReport = {
  kind: "facets-occasion-calibration";
  rubricVersion: number;
  model: string;
  measuredAt: string;
  holdout: { sha256: string; status: string; reviewed: boolean; items: number; pantry: number; pairs: number };
  thresholds: Thresholds;
  inSample: { balancedAccuracy: Record<MealOccasion, number>; perCuisine: Record<CalibrationCuisine, CuisineScore> };
  /** Leave-one-cuisine-out: what Acceptance 9 and the gate read. */
  perCuisine: Record<CalibrationCuisine, CuisineScore>;
  /** Plate plausibility with every facet abstaining (curated ladder alone), for comparison. */
  curatedOnlyPlausibility: Record<CalibrationCuisine, number>;
  /** Every leave-one-cuisine-out plate and its verdict, for review. */
  plates: PlateRecord[];
  verdict: { passes: boolean; reasons: string[] };
  answers: Answers;
};

/** 0.65–0.99: below FACET_PROMOTE_FLOOR every threshold behaves as the floor itself. */
const GRID = Array.from({ length: 35 }, (_, index) => (index + 65) / 100);
const SLUG = /^[a-z0-9-]{1,64}$/;

/** The boundary check for the holdout JSON. Throws with the first problem found. */
export function parseHoldout(value: unknown): Holdout {
  const doc = value as Partial<Holdout> | null;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.items)) throw new Error("holdout: no items");
  const seen = new Set<string>();
  for (const item of doc.items) {
    if (!item || !SLUG.test(item.id) || seen.has(item.id)) throw new Error(`holdout: bad or duplicate id ${item?.id}`);
    seen.add(item.id);
    if (!CALIBRATION_CUISINES.includes(item.cuisine)) throw new Error(`holdout: ${item.id} has unknown cuisine`);
    if (item.kind !== "food" && item.kind !== "dish") throw new Error(`holdout: ${item.id} has no kind`);
    if (typeof item.food?.name !== "string" || item.food.name.trim() === "") throw new Error(`holdout: ${item.id} has no name`);
    for (const occasion of MEAL_OCCASIONS) {
      const label = item.labels?.[occasion];
      if (label !== true && label !== false && label !== null) throw new Error(`holdout: ${item.id} ${occasion} label`);
    }
  }
  const pantry = Array.isArray(doc.pantry) ? doc.pantry : [];
  for (const item of pantry) {
    if (!item || !SLUG.test(item.id) || seen.has(item.id)) throw new Error(`holdout: bad or duplicate id ${item?.id}`);
    seen.add(item.id);
    if (!CALIBRATION_CUISINES.includes(item.cuisine)) throw new Error(`holdout: ${item.id} has unknown cuisine`);
    if (!["protein", "carb", "fat"].includes(item.role)) throw new Error(`holdout: ${item.id} has no role`);
    const macros = item.per100g;
    if (!macros || ![macros.protein, macros.carbs, macros.fat].every((v) => Number.isFinite(v) && v >= 0)
      || macros.protein + macros.carbs + macros.fat <= 0) throw new Error(`holdout: ${item.id} macros`);
    if (typeof item.food?.name !== "string" || item.food.name.trim() === "") throw new Error(`holdout: ${item.id} has no name`);
    for (const occasion of MEAL_OCCASIONS) {
      const label = item.labels?.[occasion];
      if (label !== true && label !== false && label !== null) throw new Error(`holdout: ${item.id} ${occasion} label`);
    }
  }
  return {
    status: typeof doc.status === "string" ? doc.status : "unknown",
    reviewedBy: typeof doc.reviewedBy === "string" && doc.reviewedBy.trim() ? doc.reviewedBy : null,
    reviewedAt: typeof doc.reviewedAt === "string" && doc.reviewedAt.trim() ? doc.reviewedAt : null,
    items: doc.items as HoldoutItem[],
    pantry: pantry as PantryItem[],
  };
}

/** Reviewed means the owner signed the labels off; a seed set never is. */
export function holdoutReviewed(holdout: Holdout): boolean {
  return holdout.status !== "seed" && holdout.reviewedBy !== null && holdout.reviewedAt !== null;
}

/** Every labelled pair with its answer. A labelled pair without an answer is an error, not a skip. */
export function observations(holdout: Holdout, answers: Answers): Observation[] {
  const out: Observation[] = [];
  const labelled: HoldoutItem[] = [...holdout.items,
    ...holdout.pantry.map((item) => ({ ...item, kind: "food" as const }))];
  for (const item of labelled) {
    for (const occasion of MEAL_OCCASIONS) {
      const truth = item.labels[occasion];
      if (truth === null) continue;
      const p = answers[item.id]?.[occasion];
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(`no answer for ${item.id} ${occasion}`);
      }
      out.push({ id: item.id, cuisine: item.cuisine, dish: item.kind === "dish", occasion, truth, p });
    }
  }
  return out;
}

/** (TPR + TNR) / 2; with only one class present, that class's rate; with none, 0. */
/**
 * Whether the ranking would promote this answer: exactly the production mapping
 * (lib/meals/facet-affinity.ts), so p near 0.5 is never "typical" whatever the threshold.
 */
export function promoted(p: number, threshold: number): boolean {
  return facetOccasionScore(p, threshold) !== null;
}

export function balancedAccuracy(rows: readonly Observation[], threshold: number): number {
  let tp = 0; let fn = 0; let tn = 0; let fp = 0;
  for (const row of rows) {
    const typical = promoted(row.p, threshold);
    if (row.truth) { if (typical) tp += 1; else fn += 1; } else if (typical) fp += 1; else tn += 1;
  }
  const rates = [tp + fn > 0 ? tp / (tp + fn) : null, tn + fp > 0 ? tn / (tn + fp) : null]
    .filter((rate): rate is number => rate !== null);
  return rates.length === 0 ? 0 : rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
}

/**
 * The grid threshold with the best balanced accuracy. When a run of neighbouring thresholds ties
 * (the classes separate cleanly anywhere between two answers), take the middle of the highest such
 * run, the upper middle on an even run: the widest margin on both sides, leaning conservative.
 */
export function selectThreshold(rows: readonly Observation[]): number {
  const scored = GRID.map((threshold) => ({ threshold, score: balancedAccuracy(rows, threshold) }));
  const best = Math.max(...scored.map((entry) => entry.score));
  const tied = scored.map((entry) => entry.score >= best - 1e-12);
  let end = tied.lastIndexOf(true);
  let start = end;
  while (start > 0 && tied[start - 1]) start -= 1;
  end = Math.max(start, end);
  return GRID[Math.ceil((start + end) / 2)];
}

export function selectThresholds(rows: readonly Observation[]): Thresholds {
  return Object.fromEntries(MEAL_OCCASIONS.map((occasion) =>
    [occasion, selectThreshold(rows.filter((row) => row.occasion === occasion))])) as Thresholds;
}

function correct(row: Observation, thresholds: Thresholds): boolean {
  return promoted(row.p, thresholds[row.occasion]) === row.truth;
}

function share(rows: readonly Observation[], thresholds: Thresholds): number {
  return rows.length === 0 ? 0 : rows.filter((row) => correct(row, thresholds)).length / rows.length;
}

/** The production mapping of each pantry item's answers at these thresholds (the ladder input). */
export function facetScoresFor(pantry: readonly PantryItem[], answers: Answers, thresholds: Thresholds): FacetScores {
  const out: FacetScores = {};
  for (const item of pantry) {
    const own: Partial<Record<MealOccasion, number>> = {};
    for (const occasion of MEAL_OCCASIONS) {
      const score = facetOccasionScore(answers[item.id]?.[occasion], thresholds[occasion]);
      if (score !== null) own[occasion] = score;
    }
    if (Object.keys(own).length > 0) out[item.id] = own;
  }
  return out;
}

/**
 * The rule-based plate judge, against human labels only (never Jev's own answers): plausible when
 * the plate has food on it and no food on it is labelled false (not typical) at the plate's
 * occasion. A null label (practice genuinely mixed) does not make a plate implausible.
 */
export function judgePlate(plate: GeneratedPlate, labels: ReadonlyMap<string, Record<MealOccasion, Label>>): boolean {
  if (plate.foodIds.length === 0) return false;
  return plate.foodIds.every((id) => {
    const own = labels.get(id);
    if (!own) throw new Error(`plate names unknown food ${id}`);
    return own[plate.occasion] !== false;
  });
}

export type PlateRecord = GeneratedPlate & { cuisine: CalibrationCuisine; plausible: boolean };

function cuisinePlates(holdout: Holdout, cuisine: CalibrationCuisine, answers: Answers, thresholds: Thresholds,
  generate: PlateGenerator): PlateRecord[] {
  const pantry = holdout.pantry.filter((item) => item.cuisine === cuisine);
  const labels = new Map(pantry.map((item) => [item.id, item.labels]));
  const facets = facetScoresFor(pantry, answers, thresholds);
  return MEAL_OCCASIONS.flatMap((occasion) => generate(pantry, occasion, facets)
    .map((plate) => ({ ...plate, cuisine, plausible: judgePlate(plate, labels) })));
}

function score(rows: readonly Observation[], thresholds: Thresholds, plates: readonly PlateRecord[]): CuisineScore {
  const dishes = rows.filter((row) => row.dish);
  return { accuracy: round4(share(rows, thresholds)),
    plausibility: round4(plates.length === 0 ? 0 : plates.filter((plate) => plate.plausible).length / plates.length),
    dishAccuracy: round4(share(dishes, thresholds)), pairs: rows.length, plates: plates.length };
}

/**
 * Per-cuisine scores and the plates behind them. `crossValidate` scores each cuisine at thresholds
 * selected on every other cuisine (leave-one-cuisine-out); otherwise at `thresholds`.
 */
export function perCuisine(
  holdout: Holdout, rows: readonly Observation[], answers: Answers, thresholds: Thresholds,
  crossValidate: boolean, generate: PlateGenerator,
): { scores: Record<CalibrationCuisine, CuisineScore>; plates: PlateRecord[] } {
  const scores = {} as Record<CalibrationCuisine, CuisineScore>;
  const plates: PlateRecord[] = [];
  for (const cuisine of CALIBRATION_CUISINES) {
    const own = rows.filter((row) => row.cuisine === cuisine);
    const used = crossValidate ? selectThresholds(rows.filter((row) => row.cuisine !== cuisine)) : thresholds;
    const generated = cuisinePlates(holdout, cuisine, answers, used, generate);
    plates.push(...generated);
    scores[cuisine] = score(own, used, generated);
  }
  return { scores, plates };
}

export function holdoutSha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** The whole report from a holdout, its raw text (for the hash) and Jev's answers. */
export function evaluate(
  holdout: Holdout, raw: string, answers: Answers, meta: { model: string; measuredAt: string },
  generate: PlateGenerator,
): CalibrationReport {
  const rows = observations(holdout, answers);
  const thresholds = selectThresholds(rows);
  const crossValidated = perCuisine(holdout, rows, answers, thresholds, true, generate);
  // The same plates with every facet abstaining: what the curated ladder alone would serve.
  const curatedOnly = perCuisine(holdout, rows, {}, thresholds, false, (pantry, occasion) =>
    generate(pantry, occasion, {}));
  const verdict = calibrationVerdict(crossValidated.scores);
  const reviewed = holdoutReviewed(holdout);
  if (!reviewed) verdict.reasons.push("holdout is a seed set not yet reviewed by the owner (gate stays shut)");
  return {
    kind: "facets-occasion-calibration",
    rubricVersion: OCCASION_RUBRIC_VERSION,
    model: meta.model,
    measuredAt: meta.measuredAt,
    holdout: { sha256: holdoutSha256(raw), status: holdout.status, reviewed, items: holdout.items.length,
      pantry: holdout.pantry.length, pairs: rows.length },
    thresholds,
    inSample: {
      balancedAccuracy: Object.fromEntries(MEAL_OCCASIONS.map((occasion) => [occasion,
        round4(balancedAccuracy(rows.filter((row) => row.occasion === occasion), thresholds[occasion]))])) as
        Record<MealOccasion, number>,
      perCuisine: perCuisine(holdout, rows, answers, thresholds, false, generate).scores,
    },
    perCuisine: crossValidated.scores,
    curatedOnlyPlausibility: Object.fromEntries(CALIBRATION_CUISINES.map((cuisine) =>
      [cuisine, curatedOnly.scores[cuisine].plausibility])) as Record<CalibrationCuisine, number>,
    plates: crossValidated.plates,
    verdict: { passes: verdict.passes && reviewed, reasons: verdict.reasons },
    answers,
  };
}

/** What --freeze stores: the calibration when the report passes on a reviewed holdout, else null. */
export function storedCalibration(report: CalibrationReport): StoredOccasionCalibration | null {
  if (!report.verdict.passes || !report.holdout.reviewed) return null;
  return {
    rubricVersion: report.rubricVersion,
    model: report.model,
    measuredAt: report.measuredAt,
    holdoutSha256: report.holdout.sha256,
    holdoutReviewed: report.holdout.reviewed,
    thresholds: report.thresholds,
    perCuisine: report.perCuisine,
  };
}

export const CALIBRATION_HEADER =
  "/* Generated by scripts/eval/facets-occasion-eval.ts --freeze. Do not hand-edit. */";

/** The source of lib/foods/occasion-calibration.data.ts for a stored calibration (or null). */
export function calibrationSource(stored: StoredOccasionCalibration | null): string {
  return `${CALIBRATION_HEADER}
import type { StoredOccasionCalibration } from "@/lib/foods/occasion-gate";

/**
 * The stored calibration the occasion-facet gate reads (lib/foods/occasion-gate.ts). \`null\` means
 * no passing calibration report exists yet, so v2 occasion facets abstain everywhere.
 */
export const OCCASION_CALIBRATION: StoredOccasionCalibration | null = ${
  stored === null ? "null" : JSON.stringify(stored, null, 2)};
`;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
