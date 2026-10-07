/**
 * Held-out ranking and calibration metrics for the population prior (spec §5, W1b acceptance 2).
 * Offline build only. Every mean is weighted by the respondent's dietary weight.
 *
 * Per respondent, the universe foods with a national estimate are ranked by the respondent's
 * cohort prediction (ties by food order); a food is relevant when the respondent ate at least
 * 10 g of it that day.
 *   hit@k   1 when any of the top k was eaten;
 *   NDCG@5  binary-relevance DCG of the top 5 over the ideal DCG;
 *   Brier   mean over foods of (p − y)²;
 *   ECE     |mean p − observed rate| over 10 equal-width probability bins, weighted by mass; the
 *           decile table bins the (cohort, food) cells by predicted p into ten equal-mass groups.
 * Respondents who ate none of the ranked foods have no ranking metric and are counted apart.
 * Calibration is fold-matched: each held-out observation sits in a (slot, cohort, food) cell whose
 * prediction is the one that scored it, a slot being one fold (and release) of the holdout.
 */
import { COHORTS, type Panel } from "@/scripts/priors/panel";

export type PerRespondent = { ndcg5: Float64Array; hit3: Float64Array; hit10: Float64Array; brier: Float64Array;
  ranked: Uint8Array };
export type CellMass = { predicted: Float64Array; weight: Float64Array; eaten: Float64Array };

export function emptyPerRespondent(n: number): PerRespondent {
  return { ndcg5: new Float64Array(n), hit3: new Float64Array(n), hit10: new Float64Array(n),
    brier: new Float64Array(n), ranked: new Uint8Array(n) };
}

/** Cell masses for `slots` separately fitted models (folds × releases), cohort × food each. */
export function emptyCells(F: number, slots = 1): CellMass {
  const size = slots * COHORTS.length * F;
  return { predicted: new Float64Array(size), weight: new Float64Array(size), eaten: new Float64Array(size) };
}

const DISCOUNT = [1, 2, 3, 4, 5].map((rank) => 1 / Math.log2(rank + 1));

/** Foods ranked for every cohort (descending prediction, NaN never ranked). */
function cohortRankings(table: Float64Array, F: number): Int32Array[] {
  return COHORTS.map((_, c) => {
    const order: number[] = [];
    for (let f = 0; f < F; f += 1) if (!Number.isNaN(table[c * F + f])) order.push(f);
    order.sort((a, b) => table[c * F + b] - table[c * F + a] || a - b);
    return Int32Array.from(order);
  });
}

/**
 * Scores the respondents `include` admits with `table` (or with the neutral expectation when null)
 * into `out` and the cell masses into `cells`. `neutralP` is the constant Brier prediction of the
 * neutral model and stands in for any food `table` has no estimate for.
 */
export function scoreRespondents(panel: Panel, table: Float64Array | null, ranked: ReadonlySet<number>,
  include: (i: number) => boolean, out: PerRespondent, cells: CellMass | null, neutralP = 0, slot = 0): void {
  const F = panel.foods.length;
  const base = slot * COHORTS.length * F;
  const N = ranked.size;
  const rankings = table ? cohortRankings(table, F) : null;
  /** A food a training fold could not estimate is predicted at the neutral constant. */
  const p = (c: number, f: number) => {
    const value = table ? table[c * F + f] : NaN;
    return Number.isNaN(value) ? neutralP : value;
  };
  const sumSquares = COHORTS.map((_, c) => {
    let sum = 0;
    for (const f of ranked) sum += p(c, f) ** 2;
    return sum;
  });
  for (let i = 0; i < panel.n; i += 1) {
    if (!include(i)) continue;
    const c = panel.child[i];
    const eaten = [...panel.eaten[i]].filter((f) => ranked.has(f));
    const m = eaten.length;
    let dot = 0;
    for (const f of eaten) dot += p(c, f);
    out.brier[i] = (sumSquares[c] - 2 * dot + m) / N;
    out.ranked[i] = m > 0 ? 1 : 0;
    if (cells && table) {
      for (const f of ranked) { cells.weight[base + c * F + f] += panel.weight[i]; cells.predicted[base + c * F + f] = p(c, f); }
      for (const f of eaten) cells.eaten[base + c * F + f] += panel.weight[i];
    }
    if (!m) continue;
    const ideal = DISCOUNT.slice(0, Math.min(5, m)).reduce((sum, value) => sum + value, 0);
    if (!rankings) {
      out.hit3[i] = 1 - combinationsRatio(N, m, 3);
      out.hit10[i] = 1 - combinationsRatio(N, m, 10);
      out.ndcg5[i] = (m / N) * DISCOUNT.reduce((sum, value) => sum + value, 0) / ideal;
      continue;
    }
    const set = new Set(eaten);
    const top = rankings[c];
    let dcg = 0, hit3 = 0, hit10 = 0;
    for (let r = 0; r < Math.min(10, top.length); r += 1) {
      if (!set.has(top[r])) continue;
      if (r < 5) dcg += DISCOUNT[r];
      if (r < 3) hit3 = 1;
      hit10 = 1;
    }
    out.ndcg5[i] = dcg / ideal;
    out.hit3[i] = hit3;
    out.hit10[i] = hit10;
  }
}

/** C(N − m, k) / C(N, k): the chance a random top k misses all m relevant foods. */
function combinationsRatio(N: number, m: number, k: number): number {
  let ratio = 1;
  for (let j = 0; j < k; j += 1) ratio *= Math.max(0, N - m - j) / (N - j);
  return ratio;
}

export type Summary = { respondents: number; ranked: number; hit3: number; hit10: number; ndcg5: number; brier: number };

export function summarize(panel: Panel, metrics: PerRespondent, include: (i: number) => boolean): Summary {
  let w = 0, wr = 0, hit3 = 0, hit10 = 0, ndcg = 0, brier = 0, respondents = 0, ranked = 0;
  for (let i = 0; i < panel.n; i += 1) {
    if (!include(i)) continue;
    const weight = panel.weight[i];
    respondents += 1; w += weight; brier += weight * metrics.brier[i];
    if (!metrics.ranked[i]) continue;
    ranked += 1; wr += weight;
    hit3 += weight * metrics.hit3[i]; hit10 += weight * metrics.hit10[i]; ndcg += weight * metrics.ndcg5[i];
  }
  return { respondents, ranked, hit3: hit3 / wr, hit10: hit10 / wr, ndcg5: ndcg / wr, brier: brier / w };
}

export type CalibrationBin = { lo: number; hi: number; mass: number; predicted: number; observed: number };

function bins(cells: CellMass, edges: (order: number[]) => number[][]): CalibrationBin[] {
  const order: number[] = [];
  for (let at = 0; at < cells.weight.length; at += 1) if (cells.weight[at] > 0) order.push(at);
  order.sort((a, b) => cells.predicted[a] - cells.predicted[b] || a - b);
  const total = order.reduce((sum, at) => sum + cells.weight[at], 0);
  return edges(order).filter((group) => group.length).map((group) => {
    const mass = group.reduce((sum, at) => sum + cells.weight[at], 0);
    return { lo: cells.predicted[group[0]], hi: cells.predicted[group[group.length - 1]], mass: mass / total,
      predicted: group.reduce((sum, at) => sum + cells.weight[at] * cells.predicted[at], 0) / mass,
      observed: group.reduce((sum, at) => sum + cells.eaten[at], 0) / mass };
  });
}

/** Ten equal-mass groups by predicted p. */
export function decileBins(cells: CellMass): CalibrationBin[] {
  return bins(cells, (order) => {
    const total = order.reduce((sum, at) => sum + cells.weight[at], 0);
    const groups: number[][] = Array.from({ length: 10 }, () => []);
    let running = 0;
    for (const at of order) {
      groups[Math.min(9, Math.floor((running / total) * 10))].push(at);
      running += cells.weight[at];
    }
    return groups;
  });
}

/** Ten equal-width bins over [0, 1]. */
export function widthBins(cells: CellMass): CalibrationBin[] {
  return bins(cells, (order) => {
    const groups: number[][] = Array.from({ length: 10 }, () => []);
    for (const at of order) groups[Math.min(9, Math.floor(cells.predicted[at] * 10))].push(at);
    return groups;
  });
}

export function ece(binsList: readonly CalibrationBin[]): number {
  return binsList.reduce((sum, bin) => sum + bin.mass * Math.abs(bin.predicted - bin.observed), 0);
}

/** A seeded PRNG (mulberry32) so every bootstrap is reproducible. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cluster bootstrap of a weighted mean of `values` over the admitted respondents: PSUs resampled
 * with replacement within each stratum. Returns the 2.5th and 97.5th percentiles.
 */
export function clusterBootstrap(panel: Panel, values: Float64Array, include: (i: number) => boolean,
  reps = 1000, seed = 18): { lo: number; hi: number; mean: number } {
  const K = panel.clusters.length;
  const sumW = new Float64Array(K), sumWV = new Float64Array(K);
  const strata = new Map<number, Set<number>>();
  for (let i = 0; i < panel.n; i += 1) {
    if (!include(i)) continue;
    const k = panel.cluster[i];
    sumW[k] += panel.weight[i]; sumWV[k] += panel.weight[i] * values[i];
    strata.set(panel.stratum[i], (strata.get(panel.stratum[i]) ?? new Set()).add(k));
  }
  const groups = [...strata.entries()].sort((a, b) => a[0] - b[0]).map(([, ks]) => [...ks].sort((a, b) => a - b));
  const random = prng(seed);
  const estimates: number[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    let w = 0, wv = 0;
    for (const ks of groups) for (let j = 0; j < ks.length; j += 1) {
      const k = ks[Math.floor(random() * ks.length)];
      w += sumW[k]; wv += sumWV[k];
    }
    estimates.push(wv / w);
  }
  estimates.sort((a, b) => a - b);
  const total = groups.flat().reduce((acc, k) => ({ w: acc.w + sumW[k], wv: acc.wv + sumWV[k] }), { w: 0, wv: 0 });
  return { lo: estimates[Math.floor(0.025 * reps)], hi: estimates[Math.ceil(0.975 * reps) - 1], mean: total.wv / total.w };
}
