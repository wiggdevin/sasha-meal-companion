/**
 * The respondent panel and the survey-weighted day prevalence (Phase 18 D8 part 1, W1b). Offline
 * build only; the panel lives in memory and never leaves the build (H1).
 *
 * `r_{c,f}` is the weighted share of cohort `c` who ate at least 10 g of food `f` on the recall
 * day. Its variance is the Taylor-linearised variance of a ratio under the survey design (strata,
 * PSUs sampled with replacement), as a domain estimate. The effective sample size is the NCHS one
 * for a proportion, `r(1 − r) / var(r)`, capped at the cell's respondent count; with zero variance
 * it is the Kish size.
 */
import {
  ADULT_AGE, MIN_EFFECTIVE_N, PRIOR_AGE_BANDS, PRIOR_AGE_LOWS, PRIOR_COHORTS, PRIOR_SEXES,
} from "@/lib/foods/universe/prior";
import type { Respondent, Sex } from "@/scripts/priors/nhanes";

export const GRAMS_THRESHOLD = 10;

export { MIN_EFFECTIVE_N } from "@/lib/foods/universe/prior";
/** Index 0 is the national root; 1..12 the sex by adult age children (D10 size gate), as the runtime reads them. */
export const COHORTS = PRIOR_COHORTS;

/** The respondent's child cohort, or 0 (root only) under 18: minors are in the panel only for the
 *  all-ages comparison and have no child cell. */
export function childCohort(sex: Sex, age: number): number {
  if (age < ADULT_AGE) return 0;
  const band = PRIOR_AGE_LOWS.reduce<number>((found, low, index) => (age >= low ? index : found), 0);
  return 1 + PRIOR_SEXES.indexOf(sex) * PRIOR_AGE_BANDS.length + band;
}

export type Panel = {
  n: number;
  foods: readonly string[];
  release: Uint8Array;
  cluster: Int32Array;
  stratum: Int32Array;
  child: Int32Array;
  /** 18 and over: the shipped national root's population. */
  adult: Uint8Array;
  weight: Float64Array;
  /** Offline fairness audit only (H5). */
  auditGroup: Int32Array;
  /** Food indices eaten (≥ GRAMS_THRESHOLD) per respondent, ascending. */
  eaten: Int32Array[];
  clusters: readonly string[];
  strata: readonly string[];
};

export type Expand = (release: number, code: string) => { shares: Map<string, number>; unmapped: number };

export function buildPanel(respondents: readonly Respondent[], clusters: readonly string[], foods: readonly string[],
  expand: Expand): Panel {
  const foodIndex = new Map(foods.map((key, index) => [key, index]));
  const strata = [...new Set(respondents.map((item) => item.stratum))].sort();
  const stratumIndex = new Map(strata.map((key, index) => [key, index]));
  const n = respondents.length;
  const panel: Panel = { n, foods, clusters, strata, release: new Uint8Array(n), cluster: new Int32Array(n),
    stratum: new Int32Array(n), child: new Int32Array(n), adult: new Uint8Array(n), weight: new Float64Array(n), auditGroup: new Int32Array(n), eaten: [] };
  respondents.forEach((item, i) => {
    panel.release[i] = item.release;
    panel.cluster[i] = item.cluster;
    panel.stratum[i] = stratumIndex.get(item.stratum)!;
    panel.child[i] = childCohort(item.sex, item.age);
    panel.adult[i] = item.age >= ADULT_AGE ? 1 : 0;
    panel.weight[i] = item.weight;
    panel.auditGroup[i] = item.auditGroup;
    const grams = new Map<number, number>();
    for (const [code, amount] of item.foods) {
      for (const [key, share] of expand(item.release, code).shares) {
        const at = foodIndex.get(key);
        if (at !== undefined) grams.set(at, (grams.get(at) ?? 0) + amount * share);
      }
    }
    panel.eaten.push(Int32Array.from([...grams].filter(([, amount]) => amount >= GRAMS_THRESHOLD)
      .map(([at]) => at).sort((a, b) => a - b)));
  });
  return panel;
}

/** Per cohort × food: the weighted rate, its effective count and the cell's respondent count. */
export type Rates = { rate: Float64Array; nEff: Float64Array; count: Int32Array; foods: number };

/**
 * Rates for every cohort over the respondents `include` admits. A release-specific estimate admits
 * one release; the pooled weights serve it too, since a rate does not depend on the weights' scale.
 */
export function estimateRates(panel: Panel, include: (i: number) => boolean): Rates {
  const F = panel.foods.length, C = COHORTS.length, K = panel.clusters.length;
  const W = new Float64Array(C), W2 = new Float64Array(C), count = new Int32Array(C);
  const Wk = new Float64Array(C * K), WY = new Float64Array(C * F), WYk = new Float64Array(C * F * K);
  const stratumOfCluster = new Int32Array(K).fill(-1);
  for (let i = 0; i < panel.n; i += 1) {
    if (!include(i)) continue;
    const w = panel.weight[i], k = panel.cluster[i];
    stratumOfCluster[k] = panel.stratum[i];
    for (const c of panel.child[i] ? [0, panel.child[i]] : [0]) {
      W[c] += w; W2[c] += w * w; count[c] += 1; Wk[c * K + k] += w;
      for (const f of panel.eaten[i]) { WY[c * F + f] += w; WYk[(c * F + f) * K + k] += w; }
    }
  }
  const byStratum = new Map<number, number[]>();
  for (let k = 0; k < K; k += 1) {
    const h = stratumOfCluster[k];
    if (h >= 0) byStratum.set(h, [...(byStratum.get(h) ?? []), k]);
  }
  const rate = new Float64Array(C * F), nEff = new Float64Array(C * F);
  for (let c = 0; c < C; c += 1) {
    const kish = W[c] > 0 ? (W[c] * W[c]) / W2[c] : 0;
    for (let f = 0; f < F; f += 1) {
      const r = W[c] > 0 ? WY[c * F + f] / W[c] : 0;
      let variance = 0;
      for (const ks of byStratum.values()) {
        if (ks.length < 2) continue;
        const z = ks.map((k) => (WYk[(c * F + f) * K + k] - r * Wk[c * K + k]) / W[c]);
        const mean = z.reduce((sum, value) => sum + value, 0) / z.length;
        variance += (ks.length / (ks.length - 1)) * z.reduce((sum, value) => sum + (value - mean) ** 2, 0);
      }
      rate[c * F + f] = r;
      nEff[c * F + f] = variance > 0 ? Math.min(count[c], (r * (1 - r)) / variance) : kish;
    }
  }
  return { rate, nEff, count, foods: F };
}

export const JEFFREYS = 0.5;

/**
 * Prediction table (cohort × food) from rates: the national root with a Jeffreys Beta(0.5, 0.5)
 * prior on its effective counts; each child shrunk toward it with weight `m`, or the national
 * value when the child is off or its cell is under MIN_EFFECTIVE_N. NaN marks a food whose
 * national cell is under the floor (no estimate; P_f = 0 at runtime).
 */
export function predictionTable(rates: Rates, m: number | null): Float64Array {
  const F = rates.foods, C = COHORTS.length;
  const table = new Float64Array(C * F);
  for (let f = 0; f < F; f += 1) {
    const n0 = rates.nEff[f];
    const national = n0 >= MIN_EFFECTIVE_N ? (n0 * rates.rate[f] + JEFFREYS) / (n0 + 2 * JEFFREYS) : NaN;
    table[f] = national;
    for (let c = 1; c < C; c += 1) {
      const nc = rates.nEff[c * F + f];
      table[c * F + f] = m === null || Number.isNaN(national) || nc < MIN_EFFECTIVE_N ? national
        : (nc * rates.rate[c * F + f] + m * national) / (nc + m);
    }
  }
  return table;
}
