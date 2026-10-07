/**
 * Rate-based goals (step D ruling, GPT-5.6 2026-09-22; docs/plans/2026-09-22-tdee-engine-plan.md
 * §D). One pure calculation serves the first derivation (formula TDEE) and the weekly proposal
 * (adaptive TDEE), so the two can never apply the goal twice.
 *
 * 7,700 kcal/kg is a control coefficient for both directions, not a claim about tissue energy;
 * the −20 % / +10 % TDEE caps and the adaptive loop contain its error.
 */
import type { Goal } from "../types";

export const RATE_PRESETS_BP: Readonly<Record<Goal, readonly number[]>> = {
  lose_fat: [-25, -50, -75],
  recomp: [0],
  maintain: [0],
  gain_muscle: [10, 20, 25],
};

export const DEFAULT_RATE_BP: Readonly<Record<Goal, number>> = {
  lose_fat: -50, recomp: 0, maintain: 0, gain_muscle: 20,
};

export const KCAL_PER_KG = 7700;
export const MAX_DEFICIT_FRACTION = 0.2;
export const MAX_SURPLUS_FRACTION = 0.1;
/** Protein is dosed on total weight, capped at the weight a BMI of 30 gives for the height. */
export const PROTEIN_BASIS_MAX_BMI = 30;

/** Only a preset for this goal is a valid rate; the sign must match the goal. */
export function validateRate(goal: Goal, goalRateBpWeek: number): boolean {
  return RATE_PRESETS_BP[goal].includes(goalRateBpWeek);
}

export function proteinBasisKg(weightKg: number, heightCm: number): number {
  return Math.min(weightKg, PROTEIN_BASIS_MAX_BMI * (heightCm / 100) ** 2);
}

export function macroMinimumKcal(mins: { proteinGMin: number; fatGMin: number; carbGMin: number }):
    number {
  return 4 * mins.proteinGMin + 9 * mins.fatGMin + 4 * mins.carbGMin;
}

export type RateTargetInput = {
  tdeeKcal: number;
  weightBasisKg: number;
  goalRateBpWeek: number;
  /** max(explicit account minimum, macro minimum). */
  kcalMin: number;
};

export type RateTarget = {
  targetKcal: number;
  /** Which limit set the number, so the UI can say so; null when the rate applied as chosen. */
  bound: "rate_cap" | "kcal_min" | null;
  /** The %/week the applied adjustment implies, for the clamp copy. */
  effectiveRatePctWeek: number;
};

export function rateTarget(input: RateTargetInput): RateTarget {
  const tdeeKcal = Math.round(input.tdeeKcal);
  const raw = KCAL_PER_KG * input.weightBasisKg * (input.goalRateBpWeek / 10_000) / 7;
  const low = -MAX_DEFICIT_FRACTION * tdeeKcal;
  const high = MAX_SURPLUS_FRACTION * tdeeKcal;
  const applied = Math.min(high, Math.max(low, raw));
  const capped = Math.round(tdeeKcal + applied);
  const targetKcal = Math.max(capped, Math.round(input.kcalMin));
  const bound = targetKcal > capped ? "kcal_min" : applied !== raw ? "rate_cap" : null;
  const appliedKcal = bound === "kcal_min" ? targetKcal - tdeeKcal : applied;
  const effectiveRatePctWeek = input.weightBasisKg > 0
    ? (appliedKcal * 7 / (KCAL_PER_KG * input.weightBasisKg)) * 100 : 0;
  return { targetKcal, bound, effectiveRatePctWeek };
}

/**
 * The rate a stored profile has actually confirmed: a preset for its goal, 0 for the two goals
 * that hold weight, and null when a loss or gain goal still has none (an account from before
 * step D). A null derives at maintenance and the UI asks for a choice; nothing is filled in.
 */
export function confirmedRate(goal: Goal | null | undefined, goalRateBpWeek: number | null
  | undefined): number | null {
  if (!goal) return null;
  if (DEFAULT_RATE_BP[goal] === 0) return 0;
  return typeof goalRateBpWeek === "number" && goalRateBpWeek !== 0
    && validateRate(goal, goalRateBpWeek) ? goalRateBpWeek : null;
}

type GoalRateSettings = { goal?: Goal | null; goalRateBpWeek?: number | null };

/**
 * A goal change is the one moment a rate is chosen for the user: the new goal gets its default
 * unless the same write picked a preset for it. Every other edit leaves the rate alone, so an
 * account that never confirmed one is never silently backfilled.
 */
export function settingsWithGoalRate<T extends GoalRateSettings>(before: GoalRateSettings,
  after: T): T {
  const goal = after.goal ?? null;
  const chosen = after.goalRateBpWeek;
  const valid = typeof chosen === "number" && validateRate(goal ?? "maintain", chosen);
  if (goal === (before.goal ?? null)) {
    // Same goal: a preset is kept, a null stays unconfirmed, anything else (a coach action that
    // named a rate off the presets) keeps the stored rate rather than reaching the derivation.
    return goal === null || chosen == null || valid ? after
      : { ...after, goalRateBpWeek: before.goalRateBpWeek ?? null };
  }
  if (goal === null) return { ...after, goalRateBpWeek: null };
  return { ...after, goalRateBpWeek: valid ? chosen : DEFAULT_RATE_BP[goal] };
}
