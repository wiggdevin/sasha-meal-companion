/**
 * The daily water goal from body weight (owner, 2026-10-03: "If I'm 215 pounds I shouldn't have a
 * goal of 8 cups; I should get about 128 ounces a day. This should update for everyone's plan
 * depending on their size."). Pure, and the one rule both the phone (Today, Settings) and the
 * server (the water export) call.
 *
 * The auto rule:
 *   - 0.6 US fl oz per pound of body weight (about 39 ml per kg), rounded to the nearest cup (8 oz);
 *   - clamped to 64–160 oz (8–20 cups);
 *   - a training day adds 16 oz (two cups), still capped at 160 oz;
 *   - no known weight: 64 oz (8 cups) on every day, the goal every account had before.
 *   215 lb → 128 oz · 150 lb → 88 oz · 120 lb → 72 oz (rest-day figures).
 *
 * It is derived at read time from the account's latest weight, so every account gets it with no
 * stored value and no data migration, and it follows the weight as it changes. A goal the user set
 * by hand (the per-day-type `water_goal_cups_*` columns) wins while the account is in manual mode.
 */
import { LB_PER_KG } from "./health/units";
import { categoryFor } from "./targets";
import type { DayType } from "./types";
import { DEFAULT_WATER_GOAL_CUPS, goalFor, OZ_PER_CUP, WATER_GOAL_MIN, type WaterGoalSettings } from "./water";
import type { WaterGoalMode, WaterPrefs } from "./water-prefs";

export const OZ_PER_LB = 0.6;
export const AUTO_GOAL_MIN_OZ = 64;
export const AUTO_GOAL_MAX_OZ = 160;
export const TRAINING_BONUS_OZ = 16;
export const NO_WEIGHT_GOAL_OZ = DEFAULT_WATER_GOAL_CUPS * OZ_PER_CUP;

function positive(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** The first usable weight in kilograms, in the caller's order of preference, or null. */
export function waterWeightKg(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    const kg = positive(candidate);
    if (kg !== null) return kg;
  }
  return null;
}

/** The auto goal in US fl oz for a weight in kilograms; a day type adds the training-day cups. */
export function autoGoalOz(weightKg: number | null | undefined, dayType?: DayType): number {
  const kg = positive(weightKg);
  if (kg === null) return NO_WEIGHT_GOAL_OZ;
  const cups = Math.round((kg * LB_PER_KG * OZ_PER_LB) / OZ_PER_CUP);
  const base = Math.min(AUTO_GOAL_MAX_OZ, Math.max(AUTO_GOAL_MIN_OZ, cups * OZ_PER_CUP));
  const bonus = dayType !== undefined && categoryFor(dayType) !== "rest" ? TRAINING_BONUS_OZ : 0;
  return Math.min(AUTO_GOAL_MAX_OZ, base + bonus);
}

/** The same goal in the canonical storage unit, whole cups. */
export function autoGoalCups(weightKg: number | null | undefined, dayType?: DayType): number {
  return autoGoalOz(weightKg, dayType) / OZ_PER_CUP;
}

/**
 * True when a stored goal was moved off the columns' default of 8 cups. The columns are NOT NULL
 * DEFAULT 8 (migrations 20260919090200, 20261012090000), so 8 is what every untouched account
 * holds; any other value was set by hand (the old in-card stepper, or release A's single goal).
 */
export function hasManualGoal(stored: WaterGoalSettings | undefined | null): boolean {
  return [stored?.water_goal_cups_training, stored?.water_goal_cups_rest, stored?.water_goal_cups]
    .some((value) => {
      const n = positive(value);
      return n !== null && n >= WATER_GOAL_MIN && n !== DEFAULT_WATER_GOAL_CUPS;
    });
}

/** An explicit choice wins; with none, a hand-set goal keeps the account manual, else auto. */
export function waterGoalMode(prefs: WaterPrefs | undefined | null, stored: WaterGoalSettings | undefined | null): WaterGoalMode {
  if (prefs?.goal === "auto" || prefs?.goal === "manual") return prefs.goal;
  return hasManualGoal(stored) ? "manual" : "auto";
}

export type ResolvedWaterGoal = {
  /** The goal that applies, in cups. */
  cups: number;
  mode: WaterGoalMode;
  /** What auto would give for this day, shown beside a manual goal. */
  autoCups: number;
  /** The stored goal for this day's type. */
  manualCups: number;
};

export function resolveWaterGoal({ dayType, stored, prefs, weightKg }: {
  dayType: DayType;
  stored: WaterGoalSettings | undefined | null;
  prefs: WaterPrefs | undefined | null;
  weightKg: number | null | undefined;
}): ResolvedWaterGoal {
  const autoCups = autoGoalCups(weightKg, dayType);
  const manualCups = goalFor(dayType, stored ?? undefined);
  const mode = waterGoalMode(prefs, stored);
  return { cups: mode === "manual" ? manualCups : autoCups, mode, autoCups, manualCups };
}
