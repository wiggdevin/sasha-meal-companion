/**
 * The advisory expenditure engine, `exp-3.0.0` — TDEE step E, the static → adaptive handoff.
 * Spec: docs/specs/phase-16-adaptive-handoff.md. Rulings R1–R9:
 * docs/decisions/2026-10-04-adaptive-handoff-rulings.md (GPT-6 Sol review, 2026-10-04).
 *
 * Pure: no I/O, no `Date.now()`, no randomness. Every constant is a named export with a test that
 * fails when it changes, so a tuned number is always a deliberate edit.
 *
 * Shape (replaces exp-2's EMA endpoint delta, ±10 % walk from the last stored value and the
 * confidence blend):
 *   observedN = mean intake over qualified days in the last N − Theil–Sen slope × 7700
 *   tdee      = seed + dataWeight × (observed − seed), dataWeight = clamp((lifetime − 14) / 28, 0, 1)
 * The engine is stateless: it recomputes everything from the inputs, including the history checks
 * (the previous days' observations), so a held or deferred night can never feed itself.
 * The seed and the BMR are the account's own (lib/server/profile-tdee.ts `seedFor`).
 * 7700 kcal/kg is an explicit modelling approximation, not a physical constant.
 */

import type { ActivityContextV1 } from "@/lib/activity/summary";
import { lineAt, theilSen, type DayWeight } from "@/lib/expenditure-slope";
import { CYCLE_MIN_SPAN_DAYS, CYCLE_WINDOW_DAYS, cycleAwareSlope } from "@/lib/expenditure-cycle";

export const ENGINE_VERSION = "exp-3.1.0";

export const KCAL_PER_KG = 7700;
export const ROUND_KCAL = 10;
/** Qualification: a day counts with ≥ 1,000 kcal, before `asOf`, and (R3) marked complete — or,
 *  before the account's first mark ever, with calorie coverage ≥ 0.95. */
export const MIN_ENERGY_COVERAGE = 0.95;
export const MIN_QUALIFIED_KCAL = 1000;

/** R1 — the two observation windows and what makes each valid. */
export const SHORT_WINDOW_DAYS = 14;
export const LONG_WINDOW_DAYS = 28;
export const SHORT_MIN_QUALIFIED = 10;
export const SHORT_MIN_WEIGH_DAYS = 6;
export const SHORT_MIN_SPAN_DAYS = 11;
export const LONG_MIN_QUALIFIED = 14;
export const LONG_MIN_WEIGH_DAYS = 12;
export const LONG_MIN_SPAN_DAYS = 24;
export const LONG_MIN_PER_WEEK_BLOCK = 2;
/** The newest reading must be at most this many days before `asOf`. */
export const MAX_STALE_DAYS = 2;

/** R2 — the fade schedule. */
export const FADE_START_DAYS = 14;
export const FADE_LENGTH_DAYS = 28;

/** R4 — proposal eligibility. */
export const PROPOSAL_MIN_QUALIFIED_28 = 21;
export const PROPOSAL_MIN_CALENDAR_DAYS = 28;
export const AGREEMENT_MIN_KCAL = 150;
export const AGREEMENT_PCT = 0.08;
export const CLEAN_HISTORY_DAYS = 7;
export const MAX_HALF_WIDTH_KCAL = 200;
export const MAX_HALF_WIDTH_PCT = 0.1;

/** R5 — review flags. */
export const FAR_FROM_SEED_PCT = 0.35;
export const FLAG_RELEASE_DAYS = 14;
export const BMR_LOW = 0.9;
export const BMR_HIGH = 2.2;

/** R6 — the empirical variation band. */
export const MIN_HALF_WIDTH_KCAL = 150;
export const SEED_HALF_WIDTH_PCT = 0.15;
export const RANGE_HISTORY_DAYS = 14;

/** R8 — how far back a held night looks for the last valid estimate. */
export const HELD_LOOKBACK_DAYS = 28;

export type WeighIn = { date: string; kg: number };
/** `kcal` and `energyCoverage` are the `daily_energy` row (per-item reported energy, else
 *  calculated; lib/nutrients/energy.ts); `userMarkedComplete` is
 *  `plan_days.day_complete_at` being set (step E6). */
export type IntakeDay = { date: string; kcal: number; energyCoverage: number;
  userMarkedComplete?: boolean };
export type ExpenditureStatus = "burn_in" | "held" | "estimating" | "blocked";
export type ExpenditurePhase = "starting" | "provisional" | "adaptive";
export type ReviewFlag = "far_from_seed" | "bmr_bounds";

export type ExpenditureInput = {
  asOf: string; weighIns: WeighIn[]; intake: IntakeDay[];
  /** The account's formula TDEE: the frozen revision seed, else the live profile (step E1). */
  seedKcal: number; bmrKcal: number;
  /** `user_settings.day_marks_started_on` (R3); null when the account has never marked a day. */
  marksStartedOn?: string | null;
  /** Context only (R7): passed through, never selects an observation. */
  activityContext?: ActivityContextV1;
};

export type ExpenditureResult = {
  status: ExpenditureStatus;
  phase: ExpenditurePhase;
  tdeeKcal: number | null;
  tdeeLowKcal: number | null;
  tdeeHighKcal: number | null;
  /** The 0–1 weight the observation carries over the seed (R2). */
  dataWeight: number;
  proposalEligible: boolean;
  reviewFlag: ReviewFlag | null;
  /** exp-3.1.0: the period (days) of a fluid cycle the estimate is correcting for, else null. */
  fluidCycleDays: number | null;
  observedShortKcal: number | null;
  observedLongKcal: number | null;
  weightTrendKg: number | null;
  intakeAvgKcal: number | null;
  intakeCompleteness: number;
  weighInCompleteness: number;
  /** Qualified days in the last 28. */
  qualifiedDays: number;
  /** Weigh-in days in the last 28. */
  weighInCount: number;
  /** Kept for API compatibility; equals `dataWeight`. */
  confidence: number;
  reason: string | null;
  engineVersion: string;
  learningDaysRemaining: number;
  activityContext?: ActivityContextV1;
};

const MS_PER_DAY = 86_400_000;

/** Whole days since the epoch for a "YYYY-MM-DD" calendar date. UTC arithmetic, so the runtime's
 *  own zone can never shift a day. */
export function toDayNumber(date: string): number {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

export function fromDayNumber(dayNumber: number): string {
  const d = new Date(dayNumber * MS_PER_DAY);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** R3. Marked days always qualify; unmarked days only before the account's first mark ever. */
export function isQualifiedDay(
  day: IntakeDay, asOf: string, marksStartedOn: string | null = null,
): boolean {
  // NaN passes `NaN < 1000 === false`; a non-number must never count as a day.
  if (!Number.isFinite(day.kcal) || !Number.isFinite(day.energyCoverage)) return false;
  if (day.kcal < MIN_QUALIFIED_KCAL || toDayNumber(day.date) >= toDayNumber(asOf)) return false;
  if (day.userMarkedComplete === true) return true;
  const beforeMarks = marksStartedOn === null || toDayNumber(day.date) < toDayNumber(marksStartedOn);
  return beforeMarks && day.energyCoverage >= MIN_ENERGY_COVERAGE;
}

/** A reason joined after " — " reads as one sentence: its first letter is lowercased. */
export function clause(text: string | null | undefined): string {
  if (!text) return "";
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function roundKcal(value: number): number {
  return Math.round(value / ROUND_KCAL) * ROUND_KCAL;
}

/** R6 with no observation: the seed ± 15 % (at least 150 kcal), rounded to 10 kcal. */
export function startingRange(seedKcal: number): { tdeeLowKcal: number; tdeeHighKcal: number } {
  const halfWidth = Math.max(MIN_HALF_WIDTH_KCAL, SEED_HALF_WIDTH_PCT * seedKcal);
  return { tdeeLowKcal: roundKcal(seedKcal - halfWidth), tdeeHighKcal: roundKcal(seedKcal + halfWidth) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One observation window ending the day before `endDay` (`endDay` is the night's `asOf`). */
export type Observation = {
  valid: boolean; kcal: number | null; intakeAvgKcal: number | null; trendKg: number | null;
  qualified: number; weighDays: number; reason: string | null;
  /** exp-3.1.0: the period (days) of a fluid cycle removed from this observation, else null. */
  cycleDays?: number | null;
  /** exp-3.1.0: the fitted swing (kg) on a day, so a shorter window can be de-cycled too. */
  seasonalAt?: (day: number) => number;
  /** exp-3.1.0: a level step found with the cycle, as a day number; proposals wait it out. */
  stepDay?: number | null;
};

/** A cycle must be found on these earlier nights too (same period ± tolerance) for a proposal. */
export const CYCLE_PERSIST_NIGHTS: readonly number[] = [14, 28];
export const CYCLE_PERIOD_TOLERANCE_DAYS = 3;
/** After a level step inside a cycle, proposals wait until the new trend has this many days. */
export const POST_STEP_DAYS = 28;
/** A gap longer than this between weigh-ins starts a new weigh-in history (cycle gate). */
export const WEIGH_EPISODE_GAP_DAYS = 14;

/** exp-3.1.0: the 56-day cycle-aware window needs at least this many counted days. */
export const CYCLE_MIN_QUALIFIED = 28;
/** exp-3.1.0: until a cycle can be ruled in or out, the data carries at most this weight. */
export const PRE_CYCLE_MAX_WEIGHT = 0.5;

/** True once the weigh-ins are long enough for lib/expenditure-cycle.ts to decide. */
export function cycleCheckable(series: Series, endDay: number): boolean {
  // "Long enough to test for a cycle" is a property of the account's history, not of tonight's
  // window: one missed weigh-in must not re-cap an established account (GPT-6 Sol audit).
  // Measured from the start of the CURRENT run of weigh-ins: one old reading before a long gap must
  // not satisfy the gate (GPT-6 Sol round 2).
  const days = [...series.weightKg.keys()].filter((day) => day < endDay).sort((a, b) => a - b);
  if (days.length === 0) return false;
  let start = days[0];
  for (let i = 1; i < days.length; i += 1) {
    if (days[i] - days[i - 1] > WEIGH_EPISODE_GAP_DAYS) start = days[i];
  }
  return endDay - 1 - start >= CYCLE_MIN_SPAN_DAYS;
}

/** The fade (R2), capped until a fluid cycle can be ruled in or out (exp-3.1.0). */
function weightOn(series: Series, endDay: number, lifetime: number): number {
  const scheduled = dataWeightFor(lifetime);
  return cycleCheckable(series, endDay) ? scheduled : Math.min(scheduled, PRE_CYCLE_MAX_WEIGHT);
}

/**
 * The long observation the engine uses. When the last 56 days show a periodic fluid swing
 * (lib/expenditure-cycle.ts), the swing is fitted out and the 56-day trend is the observation;
 * otherwise it is the plain 28-day Theil–Sen window, exactly as exp-3.0.0.
 */
export function observeLong(series: Series, endDay: number): Observation {
  const cached = series.longCache.get(endDay);
  if (cached) return cached;
  const result = observeLongUncached(series, endDay);
  series.longCache.set(endDay, result);
  return result;
}

function observeLongUncached(series: Series, endDay: number): Observation {
  const plain = observe(series, endDay, LONG_WINDOW_DAYS);
  // The cycle fit refines a valid recent window; it never revives stale intake (GPT-6 Sol audit).
  if (!plain.valid) return plain;
  const start = endDay - CYCLE_WINDOW_DAYS;
  const points: DayWeight[] = [];
  const kcal: number[] = [];
  for (let day = start; day < endDay; day += 1) {
    const kg = series.weightKg.get(day);
    if (kg !== undefined) points.push({ day, kg });
    const intake = series.qualifiedKcal.get(day);
    if (intake !== undefined) kcal.push(intake);
  }
  if (kcal.length < CYCLE_MIN_QUALIFIED || points.length === 0
    || endDay - points[points.length - 1].day > MAX_STALE_DAYS) return plain;
  const fit = cycleAwareSlope(points, endDay - 1);
  if (!fit || fit.periodDays === null) return plain;
  const intakeAvgKcal = kcal.reduce((sum, value) => sum + value, 0) / kcal.length;
  return { valid: true, intakeAvgKcal, qualified: plain.qualified, weighDays: plain.weighDays,
    kcal: intakeAvgKcal - fit.slopeKgPerDay * KCAL_PER_KG, trendKg: fit.trendKg, reason: null,
    cycleDays: fit.periodDays, seasonalAt: fit.seasonalAt, stepDay: fit.stepDay };
}

type Series = { qualifiedKcal: Map<number, number>; weightKg: Map<number, number>;
  /** One night's long observation, computed once per estimate (the history checks reuse it). */
  longCache: Map<number, Observation> };

/** Pre-index the inputs once: qualified days by day number, and each day's median reading. */
function seriesOf(input: ExpenditureInput): Series {
  const marks = input.marksStartedOn ?? null;
  const qualifiedKcal = new Map<number, number>();
  for (const day of input.intake) {
    if (isQualifiedDay(day, input.asOf, marks)) qualifiedKcal.set(toDayNumber(day.date), day.kcal);
  }
  const readings = new Map<number, number[]>();
  for (const w of input.weighIns) {
    if (!Number.isFinite(w.kg) || w.kg <= 0) continue;
    const day = toDayNumber(w.date);
    if (day >= toDayNumber(input.asOf)) continue;
    readings.set(day, [...(readings.get(day) ?? []), w.kg]);
  }
  const weightKg = new Map<number, number>();
  for (const [day, values] of readings) weightKg.set(day, median(values));
  return { qualifiedKcal, weightKg, longCache: new Map() };
}

export function observe(
  series: Series, endDay: number, windowDays: number, seasonalAt?: (day: number) => number,
): Observation {
  const start = endDay - windowDays;
  const kcal: number[] = [];
  const points: DayWeight[] = [];
  for (let day = start; day < endDay; day += 1) {
    const intake = series.qualifiedKcal.get(day);
    if (intake !== undefined) kcal.push(intake);
    const kg = series.weightKg.get(day);
    if (kg !== undefined) points.push({ day, kg: kg - (seasonalAt ? seasonalAt(day) : 0) });
  }
  const long = windowDays === LONG_WINDOW_DAYS;
  const minQualified = long ? LONG_MIN_QUALIFIED : SHORT_MIN_QUALIFIED;
  const minWeigh = long ? LONG_MIN_WEIGH_DAYS : SHORT_MIN_WEIGH_DAYS;
  const minSpan = long ? LONG_MIN_SPAN_DAYS : SHORT_MIN_SPAN_DAYS;
  const intakeAvgKcal = kcal.length ? kcal.reduce((sum, value) => sum + value, 0) / kcal.length
    : null;
  const empty = { valid: false, kcal: null, trendKg: null, intakeAvgKcal,
    qualified: kcal.length, weighDays: points.length };
  if (kcal.length < minQualified) {
    return { ...empty, reason: `${kcal.length} of ${minQualified} counted days in the last ${windowDays}` };
  }
  if (points.length < minWeigh) {
    return { ...empty, reason: `${points.length} of ${minWeigh} weigh-in days in the last ${windowDays}` };
  }
  const span = points[points.length - 1].day - points[0].day;
  if (span < minSpan) {
    return { ...empty, reason: `Weigh-ins cover ${span} of ${minSpan} days` };
  }
  if (endDay - points[points.length - 1].day > MAX_STALE_DAYS) {
    return { ...empty, reason: "No weigh-in in the last 2 days" };
  }
  if (long) {
    for (let block = 0; block < 4; block += 1) {
      const from = start + block * 7;
      const inBlock = points.filter((p) => p.day >= from && p.day < from + 7).length;
      if (inBlock < LONG_MIN_PER_WEEK_BLOCK) {
        return { ...empty, reason: "Weigh-ins are bunched — at least 2 a week are needed" };
      }
    }
  }
  const line = theilSen(points);
  if (!line) return { ...empty, reason: "Weight trend not defined" };
  return { valid: true, intakeAvgKcal, qualified: kcal.length, weighDays: points.length,
    kcal: (intakeAvgKcal as number) - line.slopeKgPerDay * KCAL_PER_KG,
    trendKg: lineAt(line, endDay - 1), reason: null };
}

function agrees(series: Series, endDay: number, short: Observation, long: Observation): boolean {
  // In cycle mode the 14-day window is de-cycled with the same fitted swing and then compared,
  // so a one-time change mistaken for a cycle still shows up as disagreement (GPT-6 Sol audit).
  if (long.valid && long.seasonalAt) {
    short = observe(series, endDay, SHORT_WINDOW_DAYS, long.seasonalAt);
    // The 56-day fit lags a real change; the de-cycled 28-day window must agree too, so a
    // genuine shift pauses proposals until the long fit has caught up (GPT-6 Sol audit, WARN 3).
    const recent = observe(series, endDay, LONG_WINDOW_DAYS, long.seasonalAt);
    if (!recent.valid || !withinAgreement(recent, long)) return false;
  }
  if (!short.valid || !long.valid) return false;
  return withinAgreement(short, long);
}

function withinAgreement(a: Observation, long: Observation): boolean {
  const tolerance = Math.max(AGREEMENT_MIN_KCAL, AGREEMENT_PCT * (long.kcal as number));
  return Math.abs((a.kcal as number) - (long.kcal as number)) <= tolerance;
}

function lifetimeQualifiedBefore(series: Series, endDay: number): number {
  let count = 0;
  for (const day of series.qualifiedKcal.keys()) if (day < endDay) count += 1;
  return count;
}

export function dataWeightFor(lifetimeQualified: number): number {
  return Math.min(1, Math.max(0, (lifetimeQualified - FADE_START_DAYS) / FADE_LENGTH_DAYS));
}

/** The point estimate a night would show, or null when that night has no valid observation. */
function pointOn(series: Series, endDay: number, seed: number): number | null {
  const lifetime = lifetimeQualifiedBefore(series, endDay);
  if (lifetime < FADE_START_DAYS) return null;
  const long = observeLong(series, endDay);
  const short = long.valid ? null : observe(series, endDay, SHORT_WINDOW_DAYS);
  const observed = long.valid ? long.kcal : short?.valid ? short.kcal : null;
  if (observed === null) return null;
  return seed + weightOn(series, endDay, lifetime) * (observed - seed);
}

/**
 * True when some night before `endDay` had a valid observation (pointOn). Both windows need a
 * weigh-in at most MAX_STALE_DAYS before their night, so only the nights just after a weigh-in
 * can qualify; the scan visits those, newest first, and stops at the first valid one.
 */
function everObserved(series: Series, endDay: number, seed: number): boolean {
  const nights = new Set<number>();
  for (const day of series.weightKg.keys()) {
    for (let k = 1; k <= MAX_STALE_DAYS; k += 1) if (day + k < endDay) nights.add(day + k);
  }
  return [...nights].sort((a, b) => b - a).some((night) => pointOn(series, night, seed) !== null);
}

function farFromSeed(long: Observation, seed: number): boolean {
  return long.valid && Math.abs((long.kcal as number) - seed) > FAR_FROM_SEED_PCT * seed;
}

/** R5: the flag releases after FLAG_RELEASE_DAYS consecutive nights of valid, agreeing windows. */
function farFromSeedFlag(series: Series, endDay: number, seed: number): boolean {
  const long = observeLong(series, endDay);
  if (!farFromSeed(long, seed)) return false;
  for (let k = 0; k < FLAG_RELEASE_DAYS; k += 1) {
    const day = endDay - k;
    if (!agrees(series, day, observe(series, day, SHORT_WINDOW_DAYS), observeLong(series, day))) {
      return true;
    }
  }
  return false;
}

export function estimateExpenditure(input: ExpenditureInput): ExpenditureResult {
  const { asOf, seedKcal: seed, bmrKcal } = input;
  const today = toDayNumber(asOf);
  const series = seriesOf(input);
  const lifetime = lifetimeQualifiedBefore(series, today);
  const dataWeight = weightOn(series, today, lifetime);
  const short = observe(series, today, SHORT_WINDOW_DAYS);
  const long = observeLong(series, today);
  const qualifiedDays = long.qualified;
  const weighInCount = long.weighDays;
  const firstQualified = Math.min(...series.qualifiedKcal.keys());
  const learningDaysRemaining = Math.max(0,
    FADE_START_DAYS - lifetime,
    PROPOSAL_MIN_QUALIFIED_28 - qualifiedDays,
    LONG_MIN_WEIGH_DAYS - weighInCount);
  const activityContext = input.activityContext
    ? { ...input.activityContext, residualKcal: null, smoothing: "base" as const,
      targetAdjustmentKcal: 0 as const }
    : undefined;
  const base = {
    dataWeight, confidence: dataWeight,
    observedShortKcal: short.valid ? Math.round(short.kcal as number) : null,
    observedLongKcal: long.valid ? Math.round(long.kcal as number) : null,
    fluidCycleDays: long.valid ? long.cycleDays ?? null : null,
    intakeAvgKcal: (long.valid ? long : short).intakeAvgKcal,
    intakeCompleteness: Math.min(short.qualified / SHORT_WINDOW_DAYS, 1),
    weighInCompleteness: Math.min(short.weighDays / SHORT_WINDOW_DAYS, 1),
    qualifiedDays, weighInCount, engineVersion: ENGINE_VERSION, learningDaysRemaining,
    activityContext,
  };
  const band = (center: number, halfWidth: number) => ({
    tdeeLowKcal: roundKcal(center - halfWidth), tdeeHighKcal: roundKcal(center + halfWidth) });

  if (lifetime < FADE_START_DAYS) {
    return { ...base, status: "burn_in", phase: "starting", tdeeKcal: null,
      ...startingRange(seed),
      proposalEligible: false, reviewFlag: null, weightTrendKg: null,
      reason: `Starting estimate — learning from your days, ${lifetime} of ${FADE_START_DAYS} counted` };
  }

  const observation = long.valid ? long : short.valid ? short : null;
  if (!observation) {
    // R8: a gap holds the last valid estimate; it never lowers the number.
    for (let k = 1; k <= HELD_LOOKBACK_DAYS; k += 1) {
      const previous = pointOn(series, today - k, seed);
      if (previous === null) continue;
      const shown = clampToBmr(previous, bmrKcal);
      return { ...base, status: "held", phase: "provisional", tdeeKcal: roundKcal(shown),
        ...band(shown, Math.max(MIN_HALF_WIDTH_KCAL, SEED_HALF_WIDTH_PCT * seed * (1 - dataWeight))),
        proposalEligible: false, reviewFlag: null, weightTrendKg: null,
        reason: `Holding the last estimate — ${clause(short.reason ?? long.reason)}` };
    }
    // E2 (audit 2026-10-10 P04): an account that has never had a valid observation is still
    // `starting`, whatever its counted days. The seed is the profile's number, not a learned one,
    // so it must not be shown as "Last learned" (components/TdeeLines.tsx).
    if (!everObserved(series, today, seed)) {
      return { ...base, status: "burn_in", phase: "starting", tdeeKcal: null,
        ...startingRange(seed),
        proposalEligible: false, reviewFlag: null, weightTrendKg: null,
        reason: `Starting estimate — ${clause(short.reason ?? long.reason)}` };
    }
    // R8: nothing valid in the lookback. An account that has earned 14 counted days and once had
    // a valid observation holds at the seed; it is not sent back to "starting" by a long gap.
    return { ...base, status: "held", phase: "provisional", tdeeKcal: roundKcal(seed),
      ...startingRange(seed),
      proposalEligible: false, reviewFlag: null, weightTrendKg: null,
      reason: `Holding the starting estimate — ${clause(short.reason ?? long.reason)}` };
  }

  const raw = seed + dataWeight * ((observation.kcal as number) - seed);
  const clamped = clampToBmr(raw, bmrKcal);
  const outOfBounds = clamped !== raw;
  const farFlag = farFromSeedFlag(series, today, seed);
  const reviewFlag: ReviewFlag | null = outOfBounds ? "bmr_bounds" : farFlag ? "far_from_seed" : null;

  // R6: the empirical variation band.
  let halfWidth = Math.max(MIN_HALF_WIDTH_KCAL, (1 - dataWeight) * SEED_HALF_WIDTH_PCT * seed);
  // In cycle mode the 14-day window is de-cycled first, or the band would carry the very swing the
  // long window removed (GPT-6 Sol round 2, WARN 3).
  const bandShort = long.valid && long.seasonalAt
    ? observe(series, today, SHORT_WINDOW_DAYS, long.seasonalAt) : short;
  if (bandShort.valid && long.valid) {
    halfWidth = Math.max(halfWidth, Math.abs((bandShort.kcal as number) - (long.kcal as number)));
  }
  if (long.valid) {
    for (let k = 1; k <= RANGE_HISTORY_DAYS; k += 1) {
      const earlier = observeLong(series, today - k);
      if (earlier.valid) {
        halfWidth = Math.max(halfWidth,
          Math.abs((long.kcal as number) - (earlier.kcal as number)));
      }
    }
  }

  const phase: ExpenditurePhase = long.valid ? "adaptive" : "provisional";
  const ineligible = proposalBlocker({ series, today, short, long, firstQualified, halfWidth,
    tdee: clamped, reviewFlag });
  const reason = reviewFlag === "bmr_bounds"
    ? "Outside the usual range for your body — check that every counted day is complete"
    : reviewFlag === "far_from_seed"
      ? "Your logged intake and weight don't fit together — check that every counted day is complete"
      : phase === "provisional"
        ? `Learning — ${clause(long.reason)}`
        : ineligible;
  return { ...base, status: long.valid ? "estimating" : "burn_in", phase,
    tdeeKcal: roundKcal(clamped), ...band(clamped, halfWidth),
    proposalEligible: ineligible === null, reviewFlag,
    weightTrendKg: observation.trendKg, reason };
}

function clampToBmr(value: number, bmrKcal: number): number {
  return Math.min(BMR_HIGH * bmrKcal, Math.max(BMR_LOW * bmrKcal, value));
}

/** R4. Null when a proposal may be made; otherwise the plain reason it may not. */
function proposalBlocker(args: {
  series: Series; today: number; short: Observation; long: Observation; firstQualified: number;
  halfWidth: number; tdee: number; reviewFlag: ReviewFlag | null;
}): string | null {
  const { series, today, short, long } = args;
  if (!long.valid) return long.reason;
  if (args.reviewFlag) return "Paused for review";
  // exp-3.1.0: a fluid cycle swings the 28-day window by hundreds of kcal; no change is suggested
  // until the weigh-ins are long enough to rule one in or out (lib/expenditure-cycle.ts).
  if (!cycleCheckable(series, today)) {
    return "Needs about six weeks of weigh-ins before suggesting a change";
  }
  // A cycle must persist before it can carry a proposal: the same period (± 3 days) found 14 and 28
  // nights earlier too. A one-time change fitted as a "cycle" appears only once it is in the window.
  if (long.cycleDays) {
    for (const back of CYCLE_PERSIST_NIGHTS) {
      const earlier = observeLong(series, today - back).cycleDays;
      if (!earlier || Math.abs(earlier - long.cycleDays) > CYCLE_PERIOD_TOLERANCE_DAYS) {
        return "Checking whether your weight follows a regular cycle";
      }
    }
  }
  if (long.stepDay != null && today - long.stepDay < POST_STEP_DAYS) {
    return "Your weight jumped recently — waiting for the new trend";
  }
  if (long.qualified < PROPOSAL_MIN_QUALIFIED_28) {
    return `${long.qualified} of ${PROPOSAL_MIN_QUALIFIED_28} counted days in the last 28`;
  }
  if (today - args.firstQualified < PROPOSAL_MIN_CALENDAR_DAYS) {
    return "Needs four weeks of history before suggesting a change";
  }
  if (!agrees(series, today, short, long)) return "Your last two weeks and last four weeks disagree";
  // R4: no data-quality hold on the preceding nights. A night with a valid 14-day window was a
  // healthy provisional night, not a hold.
  for (let k = 1; k <= CLEAN_HISTORY_DAYS; k += 1) {
    if (!observeLong(series, today - k).valid
      && !observe(series, today - k, SHORT_WINDOW_DAYS).valid) {
      return "Data was thin in the last week";
    }
  }
  if (args.halfWidth > Math.max(MAX_HALF_WIDTH_KCAL, MAX_HALF_WIDTH_PCT * args.tdee)) {
    return "The estimate is still moving";
  }
  return null;
}

/**
 * `blocked` is not an engine verdict: it is "a proposal would need a calorie rise above
 * max_weekly_kcal_step to satisfy a floor", which only the weekly job knows. The job calls this to
 * stamp the estimate it is about to store; every measured number is preserved.
 */
export function blockedFrom(result: ExpenditureResult, reason: string): ExpenditureResult {
  return { ...result, status: "blocked", proposalEligible: false, reason };
}
