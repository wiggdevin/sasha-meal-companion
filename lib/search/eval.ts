/**
 * Relevance measurement and threshold calibration for the Phase 1 exit gate
 * (spec acceptance criteria 8 and 9). Pure: `scripts/search-eval.ts` does the
 * talking to Postgres and hands the results in here.
 */

import { classifyQuery, parseQuery } from "./query";
import type { AutoResolveThreshold } from "./thresholds";
import type { CatalogSource, FoodSearchHit } from "@/lib/server/catalog";

export type LabelledQuery = { q: string; source: CatalogSource; sourceId: string; note?: string };
export type Runs = FoodSearchHit[][];

/**
 * The Phase 1 gate (spec acceptance criterion 8). Ruling R1, 2026-09-12: the reviewer lowered top-1 from
 * 85 % to 82 %; top-3 stays 95 %. The runner and the integration test read the gate from here.
 * Recorded in `docs/decisions/2026-09-12-session-rulings.md` and `docs/catalog/relevance.md`.
 */
export const TOP1_GATE = 0.82;
export const TOP3_GATE = 0.95;

export type GateDecision = { pass: boolean; reasons: string[] };

/**
 * Applies the gate to a measurement. Pure: the runner and the integration test both call this
 * instead of comparing against the constants themselves, so the gate has one implementation and
 * one home. `reasons` is empty on a pass; each entry is one failed gate, ready to print.
 */
export function gateDecision({ top1, top3 }: { top1: number; top3: number }): GateDecision {
  const reasons: string[] = [];
  if (top1 < TOP1_GATE) reasons.push(`top-1 ${(top1 * 100).toFixed(1)} % below the gate`);
  if (top3 < TOP3_GATE) reasons.push(`top-3 ${(top3 * 100).toFixed(1)} % below the gate`);
  return { pass: reasons.length === 0, reasons };
}

/** An auto-resolve must be right at least this often for a threshold pair to be eligible. */
export const MIN_PRECISION = 0.98;

/** Used when no grid point clears the floor: strict enough that nothing auto-resolves. */
export const CALIBRATION_FALLBACK: AutoResolveThreshold = { minScore: 0.95, minMargin: 0.3 };

const resolved = (l: LabelledQuery) => l.sourceId.length > 0;

const isCorrect = (l: LabelledQuery, h: FoodSearchHit | undefined) =>
  h !== undefined && h.source === l.source && String(h.catalogFoodId) === l.sourceId;

export function resolveLabels(
  labels: LabelledQuery[],
  byExternalId: Map<string, number>
): LabelledQuery[] {
  return labels.map((l) => {
    const id = byExternalId.get(`${l.source}:${l.sourceId}`);
    return { ...l, sourceId: id === undefined ? "" : String(id) };
  });
}

export function relevanceMetrics(
  labels: LabelledQuery[],
  runs: Runs
): { n: number; top1: number; top3: number; misses: LabelledQuery[] } {
  if (labels.length !== runs.length) {
    throw new Error("relevanceMetrics: one run per labelled query");
  }
  const misses: LabelledQuery[] = [];
  let n = 0;
  let t1 = 0;
  let t3 = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const l = labels[i];
    if (!resolved(l)) continue;
    n += 1;
    const hits = runs[i] ?? [];
    const at = hits.findIndex((h) => isCorrect(l, h));
    if (at === 0) t1 += 1;
    if (at >= 0 && at < 3) t3 += 1;
    else misses.push(l);
  }
  return { n, top1: n === 0 ? 0 : t1 / n, top3: n === 0 ? 0 : t3 / n, misses };
}

/** The search grid, ordered smallest-first: minScore 0.50–0.95 and minMargin 0.00–0.30, step 0.01. */
function grid(): AutoResolveThreshold[] {
  const out: AutoResolveThreshold[] = [];
  for (let s = 50; s <= 95; s += 1) {
    for (let m = 0; m <= 30; m += 1) out.push({ minScore: s / 100, minMargin: m / 100 });
  }
  out.sort(
    (a, b) =>
      a.minScore + a.minMargin - (b.minScore + b.minMargin) ||
      a.minScore - b.minScore ||
      a.minMargin - b.minMargin
  );
  return out;
}

export function calibrate(
  labels: LabelledQuery[],
  runs: Runs
): Record<"branded" | "generic", AutoResolveThreshold> {
  if (labels.length !== runs.length) throw new Error("calibrate: one run per labelled query");
  const out = {
    branded: { ...CALIBRATION_FALLBACK },
    generic: { ...CALIBRATION_FALLBACK },
  };
  const points = grid();
  for (const cls of ["branded", "generic"] as const) {
    const rows = labels
      .map((l, i) => ({ l, hits: runs[i] ?? [] }))
      .filter((r) => resolved(r.l) && classifyQuery(parseQuery(r.l.q)) === cls && r.hits.length >= 2);
    for (const t of points) {
      let auto = 0;
      let correct = 0;
      for (const { l, hits } of rows) {
        if (hits[0].score < t.minScore) continue;
        if (hits[0].score - hits[1].score < t.minMargin) continue;
        auto += 1;
        if (isCorrect(l, hits[0])) correct += 1;
      }
      if (auto > 0 && correct / auto >= MIN_PRECISION) {
        out[cls] = t;
        break;
      }
    }
  }
  return out;
}
