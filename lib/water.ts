/**
 * Water — Phase 3 spec, "Engines and logic". Pure. No I/O.
 *
 * `mergeCups` is the client half of the server's `greatest(water_log.cups, excluded.cups)`
 * (architecture §3.7): a cup the user drank is never un-drunk by a stale device.
 *
 * T6 (2026-09-12): the goal is per day type — a training day and a rest day can want different
 * numbers — and the card shows the same count in US ounces beside the cups.
 *
 * 2026-10-03: these per-day-type columns are the MANUAL goal. The default is now derived from body
 * weight at read time (lib/water-goal.ts), and readouts follow the account's unit (lib/water-units.ts).
 */
import type { DayType } from "./types";
import { categoryFor } from "./targets";

export const CUP_ML = 240;

/**
 * Whole cups for a millilitre amount, to the nearest cup: the water log stores whole cups. Under
 * half a cup (120 ml) is 0, and so is no water, a negative or a non-number. It used to floor at
 * one, so "no water" logged a cup (2026-10-04 audit, MINOR 8); a caller that wants a positive
 * trace to count decides that itself, and a caller that would log 0 cups should say so instead.
 */
export function wholeCups(ml: number): number {
  if (!Number.isFinite(ml) || ml <= 0) return 0;
  return Math.round(ml / CUP_ML);
}

/** "2 cups (16 oz)": how water is said back to a person (US units; nobody reads millilitres). */
export function cupsLabel(cups: number): string {
  return `${cups} ${cups === 1 ? "cup" : "cups"} (${cups * 8} oz)`;
}
/** A US cup. `CUP_ML` stays 240: that is the merge rule's unit, not a display conversion. */
export const OZ_PER_CUP = 8;
export const WATER_GOAL_MIN = 1;
export const WATER_GOAL_MAX = 30;
/** The range the Settings stepper offers: up to 160 oz (20 cups), the auto goal's ceiling. The
 *  column allows 30. */
export const WATER_GOAL_UI_MAX = 20;
export const DEFAULT_WATER_GOAL_CUPS = 8;

/** The `user_settings` columns the goal lives in, plus the legacy single goal release A keeps. */
export type WaterGoalSettings = {
  water_goal_cups_training?: number | null;
  water_goal_cups_rest?: number | null;
  water_goal_cups?: number | null;
};

export function cupsToOz(cups: number): number {
  return cups * OZ_PER_CUP;
}

export function mergeCups(mine: number, theirs: number): number {
  return Math.max(mine, theirs);
}

export function waterProgress(cups: number, goal: number): { pct: number; met: boolean } {
  if (!(goal > 0)) return { pct: 0, met: false };
  const pct = Math.round((cups / goal) * 100);
  return { pct: Math.min(100, Math.max(0, pct)), met: cups >= goal };
}

/** The range user_settings.water_goal_cups actually accepts, so the stepper can never write a
 *  value the check constraint refuses. */
export function clampGoal(cups: number): number {
  return Math.min(WATER_GOAL_MAX, Math.max(WATER_GOAL_MIN, Math.round(cups)));
}

/** The narrower range the stepper offers. `setGoal` clamps to the column behind this. */
export function clampUiGoal(cups: number): number {
  return Math.min(WATER_GOAL_UI_MAX, Math.max(WATER_GOAL_MIN, Math.round(cups)));
}

// ------------------------------------------------------------- goal per day type

/** Both training day types share one column; only a rest day has its own. */
export function goalColumnFor(dayType: DayType): "water_goal_cups_training" | "water_goal_cups_rest" {
  return categoryFor(dayType) === "rest" ? "water_goal_cups_rest" : "water_goal_cups_training";
}

/** Says which goal the stepper is editing, so a changed number is never a mystery. */
export function goalLabelFor(dayType: DayType): string {
  return categoryFor(dayType) === "rest" ? "Rest-day goal" : "Training-day goal";
}

/**
 * The goal for this day's type. A phone that upgraded before it changed anything has no per-type
 * column yet, so the legacy single goal answers for both types until the user edits one.
 */
export function goalFor(dayType: DayType, settings: WaterGoalSettings | undefined): number {
  const raw = settings?.[goalColumnFor(dayType)] ?? settings?.water_goal_cups;
  const goal = Number(raw);
  return Number.isFinite(goal) && goal >= WATER_GOAL_MIN ? goal : DEFAULT_WATER_GOAL_CUPS;
}

// ------------------------------------------------------------- goal marker

/**
 * The bar's scale. The goal tick is fixed, so the bar grows to whichever of the two is larger and
 * a day that overshoots the goal still renders a full — never overflowing — bar.
 */
export function barScale(cups: number, goal: number): number {
  return Math.max(cups, goal, WATER_GOAL_MIN);
}

/** Where a value sits on that scale, as a whole percentage clamped to 0–100. */
export function barPct(value: number, scale: number): number {
  if (!(scale > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((value / scale) * 100)));
}
