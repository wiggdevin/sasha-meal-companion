/**
 * The inferred activity chip (onboarding v2 question set §1b, gap G8): two easy answers —
 * everyday movement and workout days a week — mapped to one of the five conservative activity
 * levels (ruling R1, docs/decisions/2026-09-22-target-priors.md). The table is the question set's
 * own; a skipped answer reads as its lowest row or column, so both skipped is sedentary (1.20).
 * The chip is shown for the user to change, never saved silently. Pure: no I/O.
 */
import type { ActivityLevel } from "../types";

export const DAILY_MOVEMENTS = ["mostly_sitting", "feet_some", "feet_most", "hard_work"] as const;
export type DailyMovement = (typeof DAILY_MOVEMENTS)[number];

/** Rows: daily movement. Columns: 0, 1–2, 3–4, 5+ workout days a week. */
const TABLE: Readonly<Record<DailyMovement, readonly [ActivityLevel, ActivityLevel, ActivityLevel,
  ActivityLevel]>> = {
  mostly_sitting: ["sedentary", "light", "light", "moderate"],
  feet_some: ["light", "light", "moderate", "moderate"],
  feet_most: ["moderate", "moderate", "active", "active"],
  hard_work: ["active", "active", "active", "very_active"],
};

function column(workoutDays: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(workoutDays) || workoutDays <= 0) return 0;
  if (workoutDays <= 2) return 1;
  if (workoutDays <= 4) return 2;
  return 3;
}

/** `trainingWeekdays` is the account's chosen weekdays (JS 0–6); duplicates count once. */
export function inferActivity(input: {
  dailyMovement?: DailyMovement | null; trainingWeekdays?: readonly number[] | null;
}): ActivityLevel {
  const days = new Set((input.trainingWeekdays ?? [])
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)).size;
  return TABLE[input.dailyMovement ?? "mostly_sitting"][column(days)];
}
