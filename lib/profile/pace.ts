/**
 * The pace screen's numbers (onboarding v2 question set §2c–§2d, gap G5). One pure helper the
 * onboarding pace step and Settings both read, so a chip always shows the pace the engine will
 * actually plan: lb a week AFTER the 20 % below-burn cap and the account's own minimum, never the
 * raw preset.
 *
 * - Each preset of the goal runs through `deriveTargets` (the engine's own clamp).
 * - Direction guard: a loss preset that would not lose (the minimum sits at or above the burn),
 *   or a gain preset that would not gain, shows no chips (`kind: "minimum"`); the gentlest preset
 *   is stored and the engine holds the minimum.
 * - Chips with the same calorie target, or the same rounded label, collapse into the slower one.
 * - Steady is pre-selected when it is distinct (owner decision 2026-10-08), else the fastest
 *   distinct pace.
 * - A held account (pregnancy, breastfeeding, an eating disorder, kidney disease, a clinician-set
 *   diet; lib/profile/rate-eligibility.ts) gets no pace at all (`kind: "held"`).
 *
 * Pure: no I/O. Rounding: the magnitude, half-up to 0.1 lb.
 */
import { deriveTargets, type EnergyProfile } from "./energy";
import { DEFAULT_RATE_BP, RATE_PRESETS_BP } from "./rate-goal";
import { paceAllowed, type TargetEligibility } from "./rate-eligibility";
import type { Goal } from "../types";

export const LB_PER_KG = 2.2046226218;
/** A goal weight under this BMI for the height shows no date (§2d). */
export const GOAL_DATE_MIN_BMI = 18.5;
/** Past this many weeks the date is not shown (§2d). */
export const GOAL_DATE_MAX_WEEKS = 104;

export type PaceLabel = "Gentle" | "Steady" | "Faster";

export type PaceChoice = {
  /** The engine's preset, basis points of body weight a week: what `goalRateBpWeek` stores. */
  bp: number;
  label: PaceLabel;
  /** Magnitude in lb a week after the clamp, half-up to 0.1; 0 when `underTenth`. */
  lbPerWeek: number;
  /** The effective pace is real but rounds below 0.1 lb ("less than 0.1 lb a week"). */
  underTenth: boolean;
  /** The day's calorie target this preset gives (before the training/rest split). */
  targetKcal: number;
  /** Which limit set the number; null when the preset applied as chosen. */
  bound: "rate_cap" | "kcal_min" | null;
  effectiveRatePctWeek: number;
};

export type PaceChoices =
  /** Recomp and maintain: no follow-up, the pace is 0. */
  | { kind: "none"; goal: Goal }
  /** A held account: no pace screen, the plan stays at maintenance. */
  | { kind: "held"; goal: Goal }
  /** Direction guard: no chips and no date; store `storeBp`, the plan holds the minimum. */
  | { kind: "minimum"; goal: Goal; storeBp: number; kcalMin: number; tdeeKcal: number }
  /** 1–3 distinct chips, slowest first. One chip is a statement with a Next button. */
  | { kind: "choices"; goal: Goal; choices: PaceChoice[]; preselectedBp: number;
      kcalMin: number; tdeeKcal: number };

const LABELS: readonly PaceLabel[] = ["Gentle", "Steady", "Faster"];

/** Half-up to one decimal, on the magnitude (so 0.05 → 0.1, never banker's rounding). */
export function roundLbHalfUp(value: number): number {
  return Math.floor(Math.abs(value) * 10 + 0.5 + 1e-9) / 10;
}

function weightLb(weightKg: number): number {
  return weightKg * LB_PER_KG;
}

export type PaceInput = {
  /** The confirmed numbers; `goalRateBpWeek` is ignored (every preset is tried). */
  profile: Omit<EnergyProfile, "goalRateBpWeek">;
  /** The date the plan starts, as a Date at noon UTC (the derivation's own convention). */
  today: Date;
  trainingDays: number;
  eligibility?: TargetEligibility | null;
};

export function paceChoices(input: PaceInput): PaceChoices {
  const { goal } = input.profile;
  const presets = RATE_PRESETS_BP[goal];
  if (presets.every((bp) => bp === 0)) return { kind: "none", goal };
  if (!paceAllowed(input.eligibility)) return { kind: "held", goal };
  const losing = presets[0] < 0;
  const ordered = [...presets].sort((a, b) => Math.abs(a) - Math.abs(b));
  const lb = weightLb(input.profile.weightKg);
  const raw = ordered.map((bp, index) => {
    const { rate } = deriveTargets({ ...input.profile, goalRateBpWeek: bp }, input.today,
      input.trainingDays);
    const magnitude = lb * Math.abs(rate.effectiveRatePctWeek) / 100;
    const rounded = roundLbHalfUp(magnitude);
    return { rate, choice: {
      bp, label: LABELS[index] ?? "Faster", lbPerWeek: rounded, underTenth: rounded < 0.1,
      targetKcal: rate.targetKcal, bound: rate.bound, effectiveRatePctWeek: rate.effectiveRatePctWeek,
    } satisfies PaceChoice };
  });
  const { tdeeKcal, kcalMin } = raw[0].rate;
  const toward = (pct: number) => losing ? pct < 0 : pct > 0;
  // Direction guard (§2c step 3): the gentlest preset already fails to move toward the goal.
  if (!toward(raw[0].rate.effectiveRatePctWeek)) {
    return { kind: "minimum", goal, storeBp: ordered[0], kcalMin, tdeeKcal };
  }
  const kept: PaceChoice[] = [];
  for (const { choice } of raw) {
    if (!toward(choice.effectiveRatePctWeek)) continue;
    const same = kept.some((slower) => slower.targetKcal === choice.targetKcal
      || (slower.lbPerWeek === choice.lbPerWeek && slower.underTenth === choice.underTenth));
    if (!same) kept.push(choice);
  }
  const steady = kept.find((choice) => choice.bp === DEFAULT_RATE_BP[goal]);
  return { kind: "choices", goal, choices: kept,
    preselectedBp: (steady ?? kept[kept.length - 1]).bp, kcalMin, tdeeKcal };
}

/**
 * Speech that names a pace ("2 pounds a week", §2c step 7): the fastest distinct chip at or
 * below it, else the gentlest. `capped` is true when the plan gives less than was asked, so the
 * copy never echoes the asked-for number as accepted.
 */
export function chipForRequestedPace(
  choices: readonly PaceChoice[], requestedLbPerWeek: number,
): { choice: PaceChoice; capped: boolean } | null {
  if (choices.length === 0 || !Number.isFinite(requestedLbPerWeek)) return null;
  const asked = Math.abs(requestedLbPerWeek);
  const atOrBelow = choices.filter((choice) => choice.lbPerWeek <= asked + 1e-9);
  const choice = atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : choices[0];
  return { choice, capped: choice.lbPerWeek < asked - 1e-9 };
}

export type ImpliedDate =
  | { kind: "date"; weeks: number; date: string }
  | { kind: "none"; reason: "no_goal_weight" | "wrong_side" | "minimum_sets_pace" | "below_bmi"
      | "too_long" | "no_pace" };

/**
 * §2d: the "about Month YYYY" estimate for a goal weight. Never stored. `today` is YYYY-MM-DD; the
 * returned `date` is YYYY-MM-DD (the UI shows its month and year only, labeled as an estimate).
 */
export function impliedDate(input: {
  goal: Goal; currentLb: number; goalLb: number | null | undefined; heightCm: number;
  choice: Pick<PaceChoice, "lbPerWeek" | "underTenth" | "bound" | "effectiveRatePctWeek"> | null;
  today: string;
}): ImpliedDate {
  const { goal, currentLb, goalLb, choice } = input;
  if (goalLb == null || !Number.isFinite(goalLb)) return { kind: "none", reason: "no_goal_weight" };
  if (goal !== "lose_fat" && goal !== "gain_muscle") return { kind: "none", reason: "no_pace" };
  const losing = goal === "lose_fat";
  if (losing ? goalLb >= currentLb : goalLb <= currentLb) return { kind: "none", reason: "wrong_side" };
  const heightM = input.heightCm / 100;
  if ((goalLb / LB_PER_KG) / (heightM * heightM) < GOAL_DATE_MIN_BMI) {
    return { kind: "none", reason: "below_bmi" };
  }
  if (!choice || choice.underTenth || choice.lbPerWeek <= 0) {
    return { kind: "none", reason: choice?.bound === "kcal_min" ? "minimum_sets_pace" : "no_pace" };
  }
  if (choice.bound === "kcal_min") return { kind: "none", reason: "minimum_sets_pace" };
  const weeks = Math.ceil(Math.abs(currentLb - goalLb) / choice.lbPerWeek);
  if (weeks > GOAL_DATE_MAX_WEEKS) return { kind: "none", reason: "too_long" };
  const [year, month, day] = input.today.split("-").map(Number);
  const when = new Date(Date.UTC(year, month - 1, day + weeks * 7));
  return { kind: "date", weeks, date: when.toISOString().slice(0, 10) };
}
