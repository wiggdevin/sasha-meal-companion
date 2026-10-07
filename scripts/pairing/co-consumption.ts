/**
 * The NHANES co-consumption part of the W1c pairing feature (Phase 18 D8 part 5, D10): for an
 * anchor family F, a side food S and a meal template T, the survey-weighted share of T occasions
 * holding F that also held S, beside S's share of all T occasions. Offline build only; the input
 * occasions live in memory (H1) and only aggregate pair rates leave.
 *
 *   rate      r = Σ w·[F and S] / Σ w·[F]          over adult Day 1 occasions of template T
 *   base_rate b = Σ w·[S] / Σ w                     over the same occasions
 *   n_eff     r(1 − r) / var(r), capped at the respondents behind F's occasions; var(r) is the
 *             Taylor-linearised variance of a ratio under the survey design (strata, PSUs with
 *             replacement), as W1b computes it (scripts/priors/panel.ts). With zero variance it is
 *             the Kish size of those respondents' occasion weights.
 *   co        lift / (1 + lift), lift = r / b: 0.5 when S is as common beside F as anywhere, toward 1
 *             when it is far more common, 0 when never seen with F. A starting transform (spec:
 *             every constant is a starting value); the holdout harness scores it (calibrate.ts).
 *
 * F is present when its universe foods together reach ANCHOR_GRAMS; S when it reaches SIDE_GRAMS
 * (FAT_GRAMS for a fat: a pat of butter or a spoon of oil is under 10 g). A mixed dish counts
 * through its documented FNDDS ingredients (W1b crosswalk), as an estimate of what it contained.
 * Only fixed pairs the curated table scores (B ≥ the floor) and cells with n_eff ≥ 30 ship (H3).
 */
import type { CoRow } from "@/lib/foods/pairing/schema";
import { pairKey, PAIR_FLOOR, type CuratedPair } from "@/lib/foods/pairing/table";
import { MIN_EFFECTIVE_N } from "@/lib/foods/universe/prior";
import type { TemplateKey } from "@/lib/meals/templates";
import type { Occasion } from "@/scripts/pairing/occasions";

export const ANCHOR_GRAMS = 10;
export const SIDE_GRAMS = 10;
export const FAT_GRAMS = 3;
export const CO_TRANSFORM = "co = lift / (1 + lift), lift = rate / base_rate";

export type CoInputs = {
  occasions: readonly Occasion[];
  clusters: number;
  expand: (release: number, code: string) => { shares: ReadonlyMap<string, number> };
  /** Universe anchor food key → its anchor family key. */
  familyOf: ReadonlyMap<string, string>;
  /** Universe side food key → whether its threshold is the fat one. */
  sideIsFat: ReadonlyMap<string, boolean>;
  pairs: readonly CuratedPair[];
};

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** The `co` feature from one shipped row (the bundle derives it from the stored, rounded values). */
export function coFeature(row: Pick<CoRow, "rate" | "base_rate">): number {
  const lift = row.rate / row.base_rate;
  return lift / (1 + lift);
}

type Cell = { X: number; Xk: Float64Array; byRespondent: Map<number, number> };

export function coConsumption(input: CoInputs): CoRow[] {
  const K = input.clusters;
  const total = new Map<TemplateKey, number>();
  const sideTotal = new Map<string, number>();
  const cells = new Map<string, Cell>();
  const Y = new Map<string, number>();
  const Yk = new Map<string, Float64Array>();
  const stratumOf = new Int32Array(K).fill(-1);
  const wanted = new Set(input.pairs.map((pair) => pairKey(pair.anchor, pair.side, pair.template)));

  for (const occasion of input.occasions) {
    const { weight: w, template: T, cluster: k } = occasion;
    stratumOf[k] = occasion.stratum;
    const grams = new Map<string, number>();
    for (const [code, amount] of occasion.foods) {
      for (const [key, share] of input.expand(occasion.release, code).shares) grams.set(key, (grams.get(key) ?? 0) + amount * share);
    }
    const familyGrams = new Map<string, number>();
    const sides: string[] = [];
    for (const [key, amount] of grams) {
      const family = input.familyOf.get(key);
      if (family) familyGrams.set(family, (familyGrams.get(family) ?? 0) + amount);
      const fat = input.sideIsFat.get(key);
      if (fat !== undefined && amount >= (fat ? FAT_GRAMS : SIDE_GRAMS)) sides.push(key);
    }
    total.set(T, (total.get(T) ?? 0) + w);
    for (const side of sides) sideTotal.set(`${side}|${T}`, (sideTotal.get(`${side}|${T}`) ?? 0) + w);
    for (const [family, amount] of familyGrams) {
      if (amount < ANCHOR_GRAMS) continue;
      const cellKey = `${family}|${T}`;
      const cell = cells.get(cellKey) ?? { X: 0, Xk: new Float64Array(K), byRespondent: new Map() };
      cell.X += w; cell.Xk[k] += w;
      cell.byRespondent.set(occasion.respondent, (cell.byRespondent.get(occasion.respondent) ?? 0) + w);
      cells.set(cellKey, cell);
      for (const side of sides) {
        const key = pairKey(family, side, T);
        if (!wanted.has(key)) continue;
        Y.set(key, (Y.get(key) ?? 0) + w);
        const own = Yk.get(key) ?? new Float64Array(K);
        own[k] += w;
        Yk.set(key, own);
      }
    }
  }

  const byStratum = new Map<number, number[]>();
  for (let k = 0; k < K; k += 1) if (stratumOf[k] >= 0) byStratum.set(stratumOf[k], [...(byStratum.get(stratumOf[k]) ?? []), k]);
  const kish = new Map<string, number>();
  for (const [cellKey, cell] of cells) {
    let sum = 0, sum2 = 0;
    for (const value of cell.byRespondent.values()) { sum += value; sum2 += value * value; }
    kish.set(cellKey, sum2 > 0 ? (sum * sum) / sum2 : 0);
  }

  const rows: CoRow[] = [];
  for (const pair of input.pairs) {
    if (!(pair.b >= PAIR_FLOOR)) continue;
    const cell = cells.get(`${pair.anchor}|${pair.template}`);
    const T = total.get(pair.template) ?? 0;
    const base = T > 0 ? (sideTotal.get(`${pair.side}|${pair.template}`) ?? 0) / T : 0;
    if (!cell || !(cell.X > 0) || !(base > 0)) continue;
    const key = pairKey(pair.anchor, pair.side, pair.template);
    const r = (Y.get(key) ?? 0) / cell.X;
    const own = Yk.get(key);
    let variance = 0;
    for (const ks of byStratum.values()) {
      if (ks.length < 2) continue;
      const z = ks.map((k) => ((own ? own[k] : 0) - r * cell.Xk[k]) / cell.X);
      const mean = z.reduce((sum, value) => sum + value, 0) / z.length;
      variance += (ks.length / (ks.length - 1)) * z.reduce((sum, value) => sum + (value - mean) ** 2, 0);
    }
    const nEff = Math.floor(variance > 0 ? Math.min(cell.byRespondent.size, (r * (1 - r)) / variance)
      : Math.min(cell.byRespondent.size, kish.get(`${pair.anchor}|${pair.template}`) ?? 0));
    if (nEff < MIN_EFFECTIVE_N || round6(base) === 0) continue;
    rows.push({ anchor: pair.anchor, side: pair.side, template: pair.template, rate: round6(r), base_rate: round6(base), n_eff: nEff });
  }
  return rows.sort((a, b) => (pairKey(a.anchor, a.side, a.template) < pairKey(b.anchor, b.side, b.template) ? -1 : 1));
}
