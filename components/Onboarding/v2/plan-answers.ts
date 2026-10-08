/**
 * Onboarding v2 question set (QUESTION-SET-v2.md §1b–§4, §6): the answers the beats after the
 * body facts collect, the routing between those beats, and the plan card's list of the defaults
 * the person did not choose. Pure: no I/O, no React. Every route reads confirmed taps and local
 * checks only, never a model's judgment.
 */
import { APP_NAME } from "@/lib/brand";
import { CLINICIAN_ADVICE_FIRST_NOTE } from "@/lib/policy/profiles/condition-packs";
import { inferActivity, type DailyMovement } from "@/lib/profile/activity-infer";
import {
  eligibilityFromSafetyAnswers, isMinorOn, type SafetyAnswers, type TargetEligibility,
} from "@/lib/profile/rate-eligibility";
import type { PaceChoices } from "@/lib/profile/pace";
import type { ActivityLevel, Goal } from "@/lib/types";

/** The safety round's chips (§1c), "No, none of these" aside. */
export const SAFETY_PICKS = ["allergy", "pregnancy", "medicine", "condition", "clinician_diet"] as const;
export type SafetyPick = (typeof SAFETY_PICKS)[number];

/** The offered `medication_interaction` kinds, in plain names (§1c `medicines`). */
export const MEDICINE_KINDS = ["glp1", "warfarin", "maoi", "thyroid", "insulin", "other"] as const;
export type MedicineKind = (typeof MEDICINE_KINDS)[number];

export type PregnancyAnswer = NonNullable<SafetyAnswers["pregnancy"]>;

export type SafetyRound = {
  /** Empty means "No, none of these". */
  picks: SafetyPick[];
  pregnancy: PregnancyAnswer | null;
  medicines: MedicineKind[];
  /** The optional free-text condition. Never sent to a model. */
  conditionText: string;
};

export type WeekAnswer = {
  /** JS weekdays 0–6. Empty with `noWorkouts` false and `skipped` true means the person skipped. */
  trainingWeekdays: number[];
  noWorkouts: boolean;
  dailyMovement: DailyMovement | null;
  /** The person changed the inferred activity chip. */
  activityOverride: ActivityLevel | null;
  skipped: boolean;
};

export type DayAnswer = {
  /** null: "Pick for me" (derived from calories). */
  mealsPerDay: number | null;
  /** 24-hour "HH:MM"; null keeps the layout's first time. */
  firstMealTime: string | null;
  /** The visible "I'm in the U.S." chip (ruling 2026-10-08), on by default. */
  inUs: boolean;
};

export type PlanAnswers = {
  week: WeekAnswer | null;
  safety: SafetyRound | null;
  /** The confirmed pace preset (basis points a week); null until the pace beat is answered. */
  paceBp: number | null;
  /** Never stored: used once for the "about Month YYYY" line. */
  goalWeightLb: number | null;
  day: DayAnswer | null;
};

export function emptyPlanAnswers(): PlanAnswers {
  return { week: null, safety: null, paceBp: null, goalWeightLb: null, day: null };
}

/** The safety round as the backend's `SafetyAnswers` (lib/profile/rate-eligibility.ts). */
export function safetyAnswersFrom(round: SafetyRound | null): SafetyAnswers {
  if (!round) return {};
  return {
    pregnancy: round.picks.includes("pregnancy") ? round.pregnancy : null,
    clinicianDiet: round.picks.includes("clinician_diet"),
    conditionText: round.picks.includes("condition") ? round.conditionText.trim() || null : null,
  };
}

export function eligibilityFor(answers: PlanAnswers): TargetEligibility {
  return eligibilityFromSafetyAnswers(safetyAnswersFrom(answers.safety));
}

export function takesInsulin(round: SafetyRound | null): boolean {
  return !!round && round.picks.includes("medicine") && round.medicines.includes("insulin");
}

/** The activity level the plan uses: the person's own chip, else the inferred one (§1b). */
export function activityFor(week: WeekAnswer | null): ActivityLevel {
  if (week?.activityOverride) return week.activityOverride;
  return inferActivity({
    dailyMovement: week?.dailyMovement ?? null,
    trainingWeekdays: week?.noWorkouts ? [] : week?.trainingWeekdays ?? [],
  });
}

export function trainingWeekdaysFor(week: WeekAnswer | null): number[] {
  return week && !week.noWorkouts ? [...week.trainingWeekdays].sort((a, b) => a - b) : [];
}

export function isMinor(birthYear: number | undefined, today: string): boolean {
  return isMinorOn(birthYear ?? null, today);
}

/** The pace beat runs only on a lose or build-muscle goal that is not held, and either offers
 *  chips or states that the plan holds the minimum (§2c, §6). */
export function paceBeatNeeded(pace: PaceChoices | null): boolean {
  return pace?.kind === "choices" || pace?.kind === "minimum";
}

/** "18:30" → "6:30 PM" (US 12-hour). */
export function clock12(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

const ACTIVITY_LABEL: Record<ActivityLevel, string> = {
  sedentary: "Sedentary", light: "Light", moderate: "Moderate", active: "Active",
  very_active: "Very active",
};
export function activityLabel(level: ActivityLevel): string {
  return ACTIVITY_LABEL[level];
}

export type PlanNote = { id: string; text: string; change?: "week" | "pace" | "day" | "safety" };

/**
 * Every default the person did not choose, and every route note, for the plan card (§6 "Each
 * default the user did not choose is named on the plan card", §2e, §4b–§4d-2).
 */
export function planCardNotes(input: {
  goal: Goal | undefined;
  answers: PlanAnswers;
  pace: PaceChoices | null;
  /** The meal count and first time the plan uses (after the derived count). */
  mealCount: number;
  firstMealTime: string;
}): PlanNote[] {
  const { answers, pace } = input;
  const notes: PlanNote[] = [];
  const week = answers.week;
  if (!week || week.skipped) {
    notes.push({ id: "training", change: "week",
      text: "No workout days: every day is planned the same. Add workout days in Settings." });
  }
  if (!week?.activityOverride && (!week || week.skipped || !week.dailyMovement)) {
    notes.push({ id: "activity", change: "week",
      text: `Activity: ${activityLabel(activityFor(week))}. We started your burn estimate low. It adjusts as you log.` });
  }
  const eligibility = eligibilityFor(answers);
  const held = eligibility.holds.length > 0;
  if (input.goal === "recomp") notes.push({ id: "recomp", text: "Calories stay about where you burn. Protein stays high." });
  if (input.goal === "maintain") notes.push({ id: "maintain", text: "Calories stay about where you burn." });
  if (pace?.kind === "minimum") {
    notes.push({ id: "minimum",
      text: "Your plan stays at your nutrition minimum, about what you burn now. Logging will show what's working." });
  }
  if (held && (input.goal === "lose_fat" || input.goal === "gain_muscle")) {
    notes.push({ id: "held", change: "safety",
      text: `Calories stay about where you burn. ${APP_NAME} won't set a loss or gain pace for you.` });
  }
  if (eligibility.holds.includes("pregnancy") || eligibility.holds.includes("breastfeeding")) {
    notes.push({ id: "pregnancy",
      text: `These numbers don't add pregnancy or breastfeeding needs. ${CLINICIAN_ADVICE_FIRST_NOTE}` });
  }
  if (eligibility.holds.includes("kidney")) {
    notes.push({ id: "kidney",
      text: `Protein targets aren't set for kidney disease. ${CLINICIAN_ADVICE_FIRST_NOTE}` });
  }
  if (eligibility.holds.includes("eating_disorder")) {
    notes.push({ id: "eating_disorder",
      text: `${APP_NAME} will plan regular, balanced meals. Your treatment team's advice comes first.` });
  }
  if (eligibility.holds.includes("clinician_diet")) {
    notes.push({ id: "clinician_diet",
      text: `Your clinician guides calorie changes. ${APP_NAME} will plan meals that fit your rules.` });
  }
  if (takesInsulin(answers.safety) && input.goal === "lose_fat" && !held) {
    notes.push({ id: "insulin",
      text: "If you take insulin or a sulfonylurea, check with your clinician before eating less." });
  }
  const day = answers.day;
  if (!day || day.mealsPerDay === null) {
    notes.push({ id: "meals", change: "day", text: `${input.mealCount} meals a day, set from your calories.` });
  }
  if (!day || day.firstMealTime === null) {
    notes.push({ id: "first_meal", change: "day", text: `First meal at ${clock12(input.firstMealTime)}.` });
  }
  return notes;
}
