/**
 * Cycle-aware weight slope for the expenditure engine (exp-3.1.0). Pure: no I/O, no clock.
 *
 * A periodic fluid swing (a menstrual cycle is the common case, 24–35 days) moves a 28-day
 * Theil–Sen slope with the cycle's phase: the window holds about one period, so where it starts
 * decides the sign of the artefact (measured ±20 % of TDEE on a ±0.8 kg cycle, 2026-10-04).
 *
 * Here a longer window is fit twice by least squares — a line, and a line plus one sinusoid whose
 * period is searched over CYCLE_PERIODS — after dropping readings far from a robust line. The
 * sinusoid is kept only when it is large and the evidence for it is strong (BIC), so an account
 * with no periodic swing keeps the plain slope. When it is kept, the line's slope is the
 * underlying trend with the swing removed.
 */
import { lineAt, theilSen, type DayWeight } from "@/lib/expenditure-slope";

export const CYCLE_WINDOW_DAYS = 56;
export const CYCLE_MIN_SPAN_DAYS = 38;
/** Two readings a week over the window; fewer cannot separate a cycle from noise. */
export const CYCLE_MIN_WEIGH_DAYS = 16;
export const CYCLE_PERIODS: readonly number[] = Array.from({ length: 12 }, (_, i) => 24 + i);
/** A swing smaller than this is noise, not a cycle worth modelling (kg, half peak-to-peak). */
export const CYCLE_MIN_AMPLITUDE_KG = 0.3;
/** BIC improvement required to accept the sinusoid (≈ "very strong" evidence). */
export const CYCLE_MIN_BIC_GAIN = 10;
/** Robust outlier rule before the fit: |residual| > max(this, 3 × scaled MAD) is dropped. */
export const CYCLE_MIN_OUTLIER_KG = 0.5;
/**
 * A one-time change (a diet change, a new scale, a single drop) must not pass as a cycle
 * (GPT-6 Sol audit, 2026-10-04): the sinusoid has to beat a level step and a slope bend placed
 * anywhere at least this many days from either end of the window, by the same BIC margin.
 */
export const BREAK_EDGE_DAYS = 7;
/** A step found with a cycle must be at least this large to count (kg); smaller is fit noise. */
export const MIN_STEP_KG = 0.7;
/**
 * Repetition (GPT-6 Sol round 2): the swing must show in both halves of the window, each half at
 * least this share of the overall amplitude, with phases within MAX_HALF_PHASE_RAD. A single drop
 * or shift lives in one half only.
 */
export const MIN_HALF_AMPLITUDE_SHARE = 0.5;
export const MAX_HALF_PHASE_RAD = Math.PI / 3;

export type CycleFit = {
  slopeKgPerDay: number;
  /** The fitted swing on `day` (kg), 0 when no cycle was kept. Subtract it to de-cycle a reading. */
  seasonalAt: (day: number) => number;
  /** Fitted weight at `atDay` from the line part only (the swing removed). */
  trendKg: number;
  periodDays: number | null;
  amplitudeKg: number;
  points: number;
  /** A level step found together with the cycle (a new scale, a water shift), as a day number. */
  stepDay: number | null;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Least squares on columns `cols` (each a function of day). Null when singular. */
function leastSquares(
  points: readonly DayWeight[], cols: readonly ((day: number) => number)[],
): { beta: number[]; rss: number } | null {
  const k = cols.length;
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (const p of points) {
    const row = cols.map((col) => col(p.day));
    for (let i = 0; i < k; i += 1) {
      xty[i] += row[i] * p.kg;
      for (let j = 0; j < k; j += 1) xtx[i][j] += row[i] * row[j];
    }
  }
  // Gauss–Jordan with partial pivoting.
  const m = xtx.map((row, i) => [...row, xty[i]]);
  for (let c = 0; c < k; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < k; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-9) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < k; r += 1) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let j = c; j <= k; j += 1) m[r][j] -= f * m[c][j];
    }
  }
  const beta = m.map((row, i) => row[k] / row[i]);
  let rss = 0;
  for (const p of points) {
    const fit = cols.reduce((sum, col, i) => sum + beta[i] * col(p.day), 0);
    rss += (p.kg - fit) ** 2;
  }
  return { beta, rss };
}

const bic = (rss: number, n: number, k: number) => n * Math.log(Math.max(rss, 1e-12) / n) + k * Math.log(n);

/**
 * The swing fitted on each half of the window, after removing the full fit's line, must have a
 * similar size and phase: a cycle repeats, a one-time change does not.
 */
function repeats(
  points: readonly DayWeight[], w: number, beta: number[], amplitude: number,
): boolean {
  const residual = points.map((p) => ({ day: p.day, kg: p.kg - beta[0] - beta[1] * p.day }));
  const middle = (residual[0].day + residual[residual.length - 1].day) / 2;
  const halves = [residual.filter((p) => p.day < middle), residual.filter((p) => p.day >= middle)];
  const phases: number[] = [];
  for (const half of halves) {
    if (half.length < 6) return false;
    const fit = leastSquares(half, [() => 1, (d) => Math.sin(w * d), (d) => Math.cos(w * d)]);
    if (!fit) return false;
    if (Math.hypot(fit.beta[1], fit.beta[2]) < MIN_HALF_AMPLITUDE_SHARE * amplitude) return false;
    phases.push(Math.atan2(fit.beta[2], fit.beta[1]));
  }
  const gap = Math.abs(Math.atan2(Math.sin(phases[0] - phases[1]), Math.cos(phases[0] - phases[1])));
  return gap <= MAX_HALF_PHASE_RAD;
}

/**
 * Null when the window cannot support a cycle fit (too few readings or too short a span).
 * Otherwise the fit, with `periodDays: null` when the plain line won.
 */
export function cycleAwareSlope(points: readonly DayWeight[], atDay: number): CycleFit | null {
  if (points.length < CYCLE_MIN_WEIGH_DAYS) return null;
  const span = points[points.length - 1].day - points[0].day;
  if (span < CYCLE_MIN_SPAN_DAYS) return null;
  const robust = theilSen(points);
  if (!robust) return null;
  const residuals = points.map((p) => p.kg - lineAt(robust, p.day));
  const mad = median(residuals.map((r) => Math.abs(r - median(residuals)))) * 1.4826;
  const cutoff = Math.max(CYCLE_MIN_OUTLIER_KG, 3 * mad);
  const kept = points.filter((_, i) => Math.abs(residuals[i]) <= cutoff);
  if (kept.length < CYCLE_MIN_WEIGH_DAYS) return null;
  // Centre time for numerical stability.
  const t0 = kept[0].day;
  const shifted = kept.map((p) => ({ day: p.day - t0, kg: p.kg }));
  const line = leastSquares(shifted, [() => 1, (d) => d]);
  if (!line) return null;
  let best: { beta: number[]; rss: number; period: number } | null = null;
  for (const period of CYCLE_PERIODS) {
    const w = (2 * Math.PI) / period;
    const fit = leastSquares(shifted, [() => 1, (d) => d, (d) => Math.sin(w * d), (d) => Math.cos(w * d)]);
    if (fit && (!best || fit.rss < best.rss)) best = { ...fit, period };
  }
  const n = shifted.length;
  const none = () => 0;
  const plain = { slopeKgPerDay: line.beta[1], seasonalAt: none,
    trendKg: line.beta[0] + line.beta[1] * (atDay - t0), periodDays: null, amplitudeKg: 0,
    points: n, stepDay: null };
  if (!best) return plain;
  const amplitude = Math.hypot(best.beta[2], best.beta[3]);
  // k: line 2 params; cycle model 4 params + the searched period.
  const cycleBic = bic(best.rss, n, 5);
  if (amplitude < CYCLE_MIN_AMPLITUDE_KG || bic(line.rss, n, 2) - cycleBic < CYCLE_MIN_BIC_GAIN) {
    return plain;
  }
  // The one-time alternatives: a level step or a slope bend at the best breakpoint (3 params + the
  // searched breakpoint). A cycle is kept only if it beats the better of them by the same margin.
  const lastDay = shifted[shifted.length - 1].day;
  let breakBic = Infinity;
  for (let tau = BREAK_EDGE_DAYS; tau <= lastDay - BREAK_EDGE_DAYS; tau += 1) {
    for (const col of [(d: number) => (d >= tau ? 1 : 0), (d: number) => Math.max(0, d - tau)]) {
      const fit = leastSquares(shifted, [() => 1, (d) => d, col]);
      if (fit) breakBic = Math.min(breakBic, bic(fit.rss, n, 4));
    }
  }
  if (breakBic - cycleBic < CYCLE_MIN_BIC_GAIN) return plain;
  const w = (2 * Math.PI) / best.period;
  if (!repeats(shifted, w, best.beta, amplitude)) return plain;
  // A step on top of a cycle (GPT-6 Sol round 2): fit cycle + level step jointly at the best
  // breakpoint. When that clearly beats the cycle alone, the step is not tissue: its slope (with
  // the step removed) is the observation, and the caller pauses proposals while the step is recent.
  let joint: { beta: number[]; rss: number; tau: number } | null = null;
  for (let tau = BREAK_EDGE_DAYS; tau <= lastDay - BREAK_EDGE_DAYS; tau += 1) {
    const fit = leastSquares(shifted, [() => 1, (d) => d, (d) => Math.sin(w * d),
      (d) => Math.cos(w * d), (d) => (d >= tau ? 1 : 0)]);
    if (fit && (!joint || fit.rss < joint.rss)) joint = { ...fit, tau };
  }
  const stepped = joint !== null && cycleBic - bic(joint.rss, n, 7) >= CYCLE_MIN_BIC_GAIN
    && Math.abs(joint.beta[4]) >= MIN_STEP_KG;
  const beta = stepped && joint ? joint.beta : best.beta;
  const [a0, slope, c, d] = beta;
  const stepKg = stepped && joint ? joint.beta[4] : 0;
  return { slopeKgPerDay: slope,
    seasonalAt: (day: number) => c * Math.sin(w * (day - t0)) + d * Math.cos(w * (day - t0)),
    trendKg: a0 + slope * (atDay - t0) + stepKg,
    periodDays: best.period, amplitudeKg: Math.hypot(c, d), points: n,
    stepDay: stepped && joint ? t0 + joint.tau : null };
}
