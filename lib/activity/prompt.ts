import type { ActivityLevel } from "@/lib/types";

export const ACTIVITY_PROMPT_WINDOW_DAYS = 28;
export const ACTIVITY_PROMPT_MIN_DAYS = 14;

const LEVELS: readonly ActivityLevel[] = [
  "sedentary", "light", "moderate", "active", "very_active",
];
const DAY_MS = 86_400_000;

export type PromptDay = { local_date: string; steps: number | null };
export type ActivitySuggestion = {
  observed: ActivityLevel;
  saved: ActivityLevel;
  averageSteps: number;
  observedDays: number;
};

export function activityLevelForSteps(stepsPerDay: number): ActivityLevel {
  if (stepsPerDay < 5_000) return "sedentary";
  if (stepsPerDay < 7_500) return "light";
  if (stepsPerDay < 10_000) return "moderate";
  if (stepsPerDay < 12_500) return "active";
  return "very_active";
}

export function activityLevelLabel(level: ActivityLevel): string {
  return level === "very_active" ? "very active" : level;
}

function dayNumber(date: string): number {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function activityPromptEligibility(input: {
  days: readonly PromptDay[];
  asOf: string;
  savedActivityLevel: ActivityLevel | null;
  profileComplete: boolean;
  isSaving: boolean;
  dismissedUntil: string | null;
  now: Date;
}): ActivitySuggestion | null {
  if (!input.profileComplete || input.isSaving || input.savedActivityLevel === null) return null;
  if (input.dismissedUntil !== null) {
    const dismissedUntil = Date.parse(input.dismissedUntil);
    if (!Number.isFinite(dismissedUntil) || dismissedUntil > input.now.getTime()) return null;
  }

  const asOfDay = dayNumber(input.asOf);
  const steps = input.days.flatMap((day) => {
    const age = asOfDay - dayNumber(day.local_date);
    return age >= 1 && age <= ACTIVITY_PROMPT_WINDOW_DAYS && typeof day.steps === "number"
      ? [day.steps] : [];
  });
  if (steps.length < ACTIVITY_PROMPT_MIN_DAYS) return null;

  const averageSteps = steps.reduce((sum, value) => sum + value, 0) / steps.length;
  const observed = activityLevelForSteps(averageSteps);
  const savedIndex = LEVELS.indexOf(input.savedActivityLevel);
  const observedIndex = LEVELS.indexOf(observed);
  if (Math.abs(observedIndex - savedIndex) < 2) return null;
  return { observed, saved: input.savedActivityLevel, averageSteps, observedDays: steps.length };
}
