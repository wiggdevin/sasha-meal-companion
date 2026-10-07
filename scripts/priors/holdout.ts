/**
 * The respondent and cluster holdouts (spec §5, W1b acceptance 2 and 3). Offline build only.
 *
 * Cluster holdout: the survey PSUs are dealt into 5 folds in a seeded order; each fold is scored by
 * models fitted on the other four. Respondent holdout: respondents dealt into 5 folds the same way.
 * Nothing about a scoring fold informs its own scores (W1b round 2): its ranked food set comes from
 * the training folds, and its shrinkage m is chosen by an inner leave-one-fold-out over the training
 * folds only (nested CV). Scored respondents are adults (18+), the shipped root's population.
 *   neutral                     no prior (P_f = 0): the expectation under a random order;
 *   national all ages           a root fitted on everyone aged 2+ (the round-1 root), for comparison;
 *   national pooled / release   the adult root, from both releases or the respondent's own;
 *   sex×age pooled / release    the adult children shrunk toward the adult root with weight m.
 */
import {
  clusterBootstrap, decileBins, ece, emptyCells, emptyPerRespondent, prng, scoreRespondents, summarize, widthBins,
  type CalibrationBin, type CellMass, type PerRespondent, type Summary,
} from "@/scripts/priors/metrics";
import { estimateRates, MIN_EFFECTIVE_N, predictionTable, type Panel, type Rates } from "@/scripts/priors/panel";

export const FOLDS = 5;
export const MS = [0, 25, 50, 100, 200, 400, 800, 1600, 3200] as const;
export const RELEASE_LABELS = ["2017-2020", "2021-2023"] as const;

export type ModelName = "neutral" | "national_all_ages" | "national_pooled" | "national_release" | "sexage_pooled"
  | "sexage_release";
export const MODELS: readonly ModelName[] = ["neutral", "national_all_ages", "national_pooled", "national_release",
  "sexage_pooled", "sexage_release"];

function deal(count: number, seed: number): Int32Array {
  const order = Array.from({ length: count }, (_, i) => i);
  const random = prng(seed);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const fold = new Int32Array(count);
  order.forEach((item, position) => { fold[item] = position % FOLDS; });
  return fold;
}

export function foldsFor(panel: Panel, kind: "cluster" | "respondent"): Int32Array {
  if (kind === "respondent") return deal(panel.n, 1801);
  const byCluster = deal(panel.clusters.length, 1802);
  return Int32Array.from(panel.cluster, (k) => byCluster[k]);
}

/** Foods with a root estimate in `rates`: eaten by someone and n_eff >= 30. */
export function rankedFrom(rates: Rates): Set<number> {
  const out = new Set<number>();
  for (let f = 0; f < rates.foods; f += 1) if (rates.rate[f] > 0 && rates.nEff[f] >= MIN_EFFECTIVE_N) out.add(f);
  return out;
}

function neutralOf(table: Float64Array, ranked: ReadonlySet<number>): number {
  let mean = 0;
  for (const f of ranked) mean += Number.isNaN(table[f]) ? 0 : table[f];
  return mean / ranked.size;
}

export type MFit = { m: number; byM: { m: number; ndcg5: number; brier: number }[] };

/** m by leave-one-fold-out over `folds` only (adults): best weighted NDCG@5, ties to the larger m. */
export function innerFitM(panel: Panel, fold: Int32Array, folds: readonly number[]): MFit {
  const per = new Map(MS.map((value) => [value, emptyPerRespondent(panel.n)]));
  for (const j of folds) {
    const rates = estimateRates(panel, (i) => panel.adult[i] === 1 && folds.includes(fold[i]) && fold[i] !== j);
    const ranked = rankedFrom(rates);
    const neutralP = neutralOf(predictionTable(rates, null), ranked);
    const test = (i: number) => panel.adult[i] === 1 && fold[i] === j;
    for (const value of MS) scoreRespondents(panel, predictionTable(rates, value), ranked, test, per.get(value)!, null, neutralP);
  }
  const scope = (i: number) => panel.adult[i] === 1 && folds.includes(fold[i]);
  const byM = MS.map((value) => {
    const summary = summarize(panel, per.get(value)!, scope);
    return { m: value, ndcg5: summary.ndcg5, brier: summary.brier };
  });
  const best = byM.reduce((a, b) => (b.ndcg5 > a.ndcg5 + 1e-12 || (Math.abs(b.ndcg5 - a.ndcg5) <= 1e-12 && b.m > a.m) ? b : a));
  return { m: best.m, byM };
}

export type HoldoutRun = { perModel: Record<ModelName, PerRespondent>; cells: Record<ModelName, CellMass>;
  mByFold: number[]; rankedByFold: number[] };

/** Out-of-fold scores for every model; calibration cells are kept per fold and release (fold-matched). */
export function runHoldout(panel: Panel, fold: Int32Array): HoldoutRun {
  const F = panel.foods.length;
  const perModel = Object.fromEntries(MODELS.map((name) => [name, emptyPerRespondent(panel.n)])) as Record<ModelName, PerRespondent>;
  const cells = Object.fromEntries(MODELS.map((name) => [name, emptyCells(F, FOLDS * RELEASE_LABELS.length)])) as Record<ModelName, CellMass>;
  const mByFold: number[] = [], rankedByFold: number[] = [];
  for (let k = 0; k < FOLDS; k += 1) {
    const inner = Array.from({ length: FOLDS }, (_, j) => j).filter((j) => j !== k);
    const m = innerFitM(panel, fold, inner).m;
    const train = (i: number) => panel.adult[i] === 1 && fold[i] !== k;
    const test = (i: number) => panel.adult[i] === 1 && fold[i] === k;
    const pooled = estimateRates(panel, train);
    const ranked = rankedFrom(pooled);
    const national = predictionTable(pooled, null);
    const neutralP = neutralOf(national, ranked);
    const slot = k * RELEASE_LABELS.length;
    mByFold.push(m); rankedByFold.push(ranked.size);
    scoreRespondents(panel, null, ranked, test, perModel.neutral, null, neutralP);
    const allAges = predictionTable(estimateRates(panel, (i) => fold[i] !== k), null);
    scoreRespondents(panel, allAges, ranked, test, perModel.national_all_ages, cells.national_all_ages, neutralP, slot);
    scoreRespondents(panel, national, ranked, test, perModel.national_pooled, cells.national_pooled, neutralP, slot);
    scoreRespondents(panel, predictionTable(pooled, m), ranked, test, perModel.sexage_pooled, cells.sexage_pooled, neutralP, slot);
    for (let release = 0; release < RELEASE_LABELS.length; release += 1) {
      const own = estimateRates(panel, (i) => train(i) && panel.release[i] === release);
      const testOwn = (i: number) => test(i) && panel.release[i] === release;
      scoreRespondents(panel, predictionTable(own, null), ranked, testOwn, perModel.national_release, cells.national_release,
        neutralP, slot + release);
      scoreRespondents(panel, predictionTable(own, m), ranked, testOwn, perModel.sexage_release, cells.sexage_release,
        neutralP, slot + release);
    }
  }
  return { perModel, cells, mByFold, rankedByFold };
}

export type Scope = "all" | (typeof RELEASE_LABELS)[number];
export const SCOPES: readonly Scope[] = ["all", ...RELEASE_LABELS];

/** Adults in the scope (the holdouts score adults only). */
export function scopeFilter(panel: Panel, scope: Scope): (i: number) => boolean {
  if (scope === "all") return (i) => panel.adult[i] === 1;
  const release = RELEASE_LABELS.indexOf(scope);
  return (i) => panel.adult[i] === 1 && panel.release[i] === release;
}

export type ModelReport = { model: ModelName; scope: Scope; summary: Summary };

export function summarizeRun(panel: Panel, run: HoldoutRun): ModelReport[] {
  return MODELS.flatMap((model) => SCOPES.map((scope) => ({ model, scope,
    summary: summarize(panel, run.perModel[model], scopeFilter(panel, scope)) })));
}

export type Calibration = { brier: number; ece: number; eceDecile: number; deciles: CalibrationBin[] };

export function calibrationOf(panel: Panel, run: HoldoutRun, model: ModelName): Calibration {
  const deciles = decileBins(run.cells[model]);
  return { brier: summarize(panel, run.perModel[model], scopeFilter(panel, "all")).brier, ece: ece(widthBins(run.cells[model])),
    eceDecile: ece(deciles), deciles };
}

export type Lift = { gain: number; lo: number; hi: number; byRelease: Record<string, number>; signsAgree: boolean };

/** NDCG@5 gain of `child` over `parent`, with its cluster-bootstrap interval and the mode-change check. */
export function liftOf(panel: Panel, child: PerRespondent, parent: PerRespondent): Lift {
  const gain = Float64Array.from({ length: panel.n }, (_, i) => child.ndcg5[i] - parent.ndcg5[i]);
  const ranked = (i: number) => child.ranked[i] === 1;
  const interval = clusterBootstrap(panel, gain, ranked);
  const byRelease = Object.fromEntries(RELEASE_LABELS.map((label, release) => {
    let w = 0, wg = 0;
    for (let i = 0; i < panel.n; i += 1) if (ranked(i) && panel.release[i] === release) { w += panel.weight[i]; wg += panel.weight[i] * gain[i]; }
    return [label, wg / w];
  }));
  const signs = Object.values(byRelease).map(Math.sign);
  return { gain: interval.mean, lo: interval.lo, hi: interval.hi, byRelease, signsAgree: signs.every((sign) => sign === signs[0]) };
}
