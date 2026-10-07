import {
  FACET_THRESHOLDS,
  NOT_HUMAN_FOOD_THRESHOLDS,
  PORTION_LEVEL_THRESHOLDS,
} from "@/lib/foods/facet-thresholds";
import type { Facet } from "@/lib/foods/facets";
import { score } from "./cache";
import {
  GENERATED_HEADER,
  PORTION_LEVELS,
  type ActionThresholds,
  type EvalCase,
  type JudgmentsCache,
  type Matrix,
  type Observation,
  type Pair,
  type Split,
} from "./types";

export function observations(cases: Record<Split, EvalCase[]>, cache: JudgmentsCache,
  facets: readonly Facet[]): Record<string, Observation[]> {
  const result: Record<string, Observation[]> = {};
  for (const [split, items] of Object.entries(cases) as [Split, EvalCase[]][]) {
    for (const item of items) {
      if (item.operationalCase) continue;
      for (const facet of facets) {
        const truth = item.labels.present.includes(facet);
        const confusableAbsent = item.labels.confusableAbsent?.includes(facet) ?? false;
        if (truth || confusableAbsent) {
          add(result, facet, item.id, split, truth, score(cache, item.id, facet));
        }
      }
      add(result, "not_human_food", item.id, split, item.labels.notHumanFood,
        score(cache, item.id, "not_human_food"));
      if (item.labels.portionLevel) PORTION_LEVELS.forEach((level, index) => add(
        result,
        `portion:${level}`,
        item.id,
        split,
        item.labels.portionLevel === level,
        score(cache, item.id, "portion_level", index),
      ));
    }
  }
  return result;
}

export function deriveThresholds(observed: Record<string, Observation[]>): Record<string, ActionThresholds> {
  return Object.fromEntries(Object.entries(observed).map(([key, rows]) => {
    const dev = rows.filter((row) => row.split === "dev");
    return [key, { mark: choose(dev, 0.1, 0.1), exclude: choose(dev, 0, 0.02) }];
  }));
}

export function frozenThresholds(): Record<string, ActionThresholds> {
  return {
    ...FACET_THRESHOLDS,
    not_human_food: NOT_HUMAN_FOOD_THRESHOLDS,
    ...Object.fromEntries(PORTION_LEVELS.map((level) => [
      `portion:${level}`,
      { mark: PORTION_LEVEL_THRESHOLDS[level].warn, exclude: PORTION_LEVEL_THRESHOLDS[level].exclude },
    ])),
  };
}

export function tsSource(facets: readonly Facet[], thresholds: Record<string, ActionThresholds>,
  model: string): string {
  const facetMap = Object.fromEntries(facets.map((facet) => [facet, thresholds[facet]]));
  const portionMap = Object.fromEntries(PORTION_LEVELS.map((level) => [level, {
    warn: thresholds[`portion:${level}`].mark,
    exclude: thresholds[`portion:${level}`].exclude,
  }]));
  return `${GENERATED_HEADER}\nimport type { Facet } from "@/lib/foods/facets";\n\n`
    + `export const FACET_THRESHOLD_RUBRIC_VERSION = 1;\nexport const FACET_THRESHOLD_MODEL = ${JSON.stringify(model)};\n`
    + "export const FACET_THRESHOLD_DATE = \"2026-09-20\";\n\n"
    + "export type ProbabilityBand = { readonly present: number; readonly absent: number };\n"
    + "export type FacetActionThresholds = { readonly mark: ProbabilityBand; readonly exclude: ProbabilityBand };\n\n"
    + `export const FACET_THRESHOLDS = ${JSON.stringify(facetMap, null, 2)} as const satisfies Record<Facet, FacetActionThresholds>;\n\n`
    + `export const NOT_HUMAN_FOOD_THRESHOLDS = ${JSON.stringify(thresholds.not_human_food, null, 2)} as const satisfies FacetActionThresholds;\n\n`
    + `export const PORTION_LEVEL_THRESHOLDS = ${JSON.stringify(portionMap, null, 2)} as const;\n`;
}

export function matrix(rows: Observation[], pair: Pair): Matrix {
  const out: Matrix = { tp: 0, fp: 0, tn: 0, fn: 0, up: 0, un: 0 };
  for (const row of rows) {
    if (row.p >= pair.present) {
      if (row.truth) out.tp += 1;
      else out.fp += 1;
    } else if (row.p <= pair.absent) {
      if (row.truth) out.fn += 1;
      else out.tn += 1;
    } else if (row.truth) out.up += 1;
    else out.un += 1;
  }
  return out;
}

export function rates(m: Matrix) {
  return {
    precision: ratio(m.tp, m.tp + m.fp),
    recall: ratio(m.tp, m.tp + m.fn + m.up),
    fpr: ratio(m.fp, m.fp + m.tn + m.un),
    coverage: ratio(m.tp + m.fp + m.tn + m.fn, m.tp + m.fp + m.tn + m.fn + m.up + m.un),
  };
}

export function ratio(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

function add(result: Record<string, Observation[]>, key: string, id: string, split: Split,
  truth: boolean, p: number): void {
  if (!Number.isFinite(p)) throw new Error(`Missing probability for ${id} ${key}`);
  (result[key] ??= []).push({ id, split, truth, p });
}

function choose(rows: Observation[], maxFpr: number, maxFalseAbsent: number): Pair {
  const values = [...new Set([0, 1, ...rows.map((row) => round(Math.min(1, row.p + 0.001)))])]
    .sort((a, b) => a - b);
  const high = values.map((present) => ({ present, m: matrix(rows, { present, absent: -1 }) }))
    .filter(({ m }) => rates(m).fpr <= maxFpr)
    .sort((a, b) => rates(b.m).recall - rates(a.m).recall || a.present - b.present)[0]?.present ?? 1;
  const positives = rows.filter((row) => row.truth).length;
  const lows = values.filter((absent) => absent < high).map((absent) => ({
    absent,
    falseAbsent: ratio(rows.filter((row) => row.truth && row.p <= absent).length, positives),
    trueAbsent: rows.filter((row) => !row.truth && row.p <= absent).length,
  }));
  const low = lows.filter((item) => item.falseAbsent <= maxFalseAbsent)
    .sort((a, b) => b.trueAbsent - a.trueAbsent || b.absent - a.absent)[0]?.absent ?? 0;
  return { present: round(high), absent: round(low) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
