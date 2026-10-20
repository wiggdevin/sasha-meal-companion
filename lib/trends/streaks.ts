/**
 * Streaks for the "Your week" card (UI makeover §11, W4). Pure, from the window's `TrendDay`s.
 *
 * A streak counts back from today. Today is still open, so a today that does not (yet) qualify
 * neither counts nor breaks it: the count starts from yesterday. A day that is missing, partial or
 * cannot be judged ends the streak; nothing is guessed. `capped` says the streak reaches the start
 * of the window, so the true run may be longer ("28+ days").
 */
import { metGoal, type TrendDay } from "@/lib/trends/series";

export type StreakKind = "on_plan" | "fully_logged" | "water";
export type Streak = { kind: StreakKind; days: number; capped: boolean };

/** True, false, or null when the day cannot be judged (which ends a streak like false). */
export function qualifies(kind: StreakKind, day: TrendDay): boolean | null {
  switch (kind) {
    case "fully_logged": return day.fullyLogged;
    case "on_plan":
      if (day.kcal === null || day.kcalTarget === null || day.kcalTarget <= 0 || day.intakePartial) return null;
      return metGoal("kcal", day.kcal, day.kcalTarget);
    case "water":
      if (day.cups === null || day.waterGoal === null || day.waterGoal <= 0) return null;
      return day.cups >= day.waterGoal;
  }
}

/** The run of qualifying days ending today (or yesterday, while today has not qualified yet). */
export function streak(kind: StreakKind, days: TrendDay[]): Streak {
  let end = days.length - 1;
  if (end >= 0 && days[end].today && qualifies(kind, days[end]) !== true) end -= 1;
  let count = 0;
  for (let i = end; i >= 0; i -= 1) {
    if (qualifies(kind, days[i]) !== true) return { kind, days: count, capped: false };
    count += 1;
  }
  return { kind, days: count, capped: count > 0 && count === end + 1 };
}

/**
 * The three streaks the card shows. `on_plan` needs a target revision to mean anything, so it is
 * left out while no day in the window has one; `water` likewise without a goal.
 */
export function streaks(days: TrendDay[]): Streak[] {
  const out: Streak[] = [];
  if (days.some((day) => day.kcalTarget !== null)) out.push(streak("on_plan", days));
  out.push(streak("fully_logged", days));
  if (days.some((day) => day.waterGoal !== null)) out.push(streak("water", days));
  return out;
}

export const STREAK_LABEL: Record<StreakKind, string> = {
  on_plan: "On plan",
  fully_logged: "Fully logged",
  water: "Water goal",
};

/** What each streak counts, in one line (the cell's accessible description). */
export const STREAK_MEANS: Record<StreakKind, string> = {
  on_plan: "days in a row within 10% of your calorie target",
  fully_logged: "days in a row marked fully logged",
  water: "days in a row at your water goal",
};

export function streakFigure(s: Streak): string {
  return `${s.days}${s.capped ? "+" : ""}`;
}
