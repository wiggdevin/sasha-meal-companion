import { adjustCalories, type DayCategory } from "@/lib/scaling";
import {
  ACTIVITY_MODEL_VERSION, bmr, bmrMethod, deriveTargets, energyProfileFrom, isProfileComplete,
  weightForTargets,
} from "@/lib/profile/energy";
import type { EnergyFloorBound } from "@/lib/profile/energy";
import type {
  Macros, Settings, TargetPins, TargetRevision, TargetRevisionFloors, TargetSeed, TargetSet,
  TargetSource,
} from "@/lib/types";

export type { TargetRevisionFloors } from "@/lib/types";

export const TARGET_FORMULA_NAME = "profile-energy-v1";
/** Names the derivation that froze a revision's seed (TDEE step E1). Bump it when the BMR, the
 *  activity table or the seed rounding changes, so a stored seed says which rules made it. */
export const TARGET_DERIVATION_VERSION = "derive-2026-10-04";
const KCAL_PER_G_PROTEIN = 4;
const PROFILE_FAT_G_MIN = 50;
const PROFILE_CARB_G_MIN = 100;

export type DeriveTargetRevisionInput = {
  settings: Settings;
  latestWeighInKg: number | null;
  today: string;
  trainingWeekdays: readonly number[];
  source?: Extract<TargetSource, "derived" | "manual">;
};

/** A pin makes the resolved numbers user-authored even when profile inputs trigger the recompute. */
export function targetSourceFor(
  settings: Pick<Settings, "trainingKcal" | "restKcal" | "proteinG">,
): Extract<TargetSource, "derived" | "manual"> {
  return settings.trainingKcal !== null || settings.restKcal !== null || settings.proteinG !== null
    ? "manual"
    : "derived";
}

function macrosWithPins(
  base: Macros,
  category: DayCategory,
  kcalPin: number | null,
  proteinPin: number | null,
): Macros {
  if (kcalPin === null && proteinPin === null) return { ...base };
  const protein = proteinPin ?? base.protein;
  const baseline = {
    protein,
    carbs: base.carbs,
    fat: base.fat,
    kcal: base.kcal + (protein - base.protein) * KCAL_PER_G_PROTEIN,
  };
  return adjustCalories(baseline, kcalPin ?? base.kcal, category).macros;
}

export function applyTargetPins(base: TargetSet, pins: TargetPins): TargetSet {
  return {
    training: macrosWithPins(base.training, "training", pins.trainingKcal, pins.proteinG),
    rest: macrosWithPins(base.rest, "rest", pins.restKcal, pins.proteinG),
  };
}

function effectiveDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Target date must be YYYY-MM-DD");
  return new Date(`${value}T12:00:00.000Z`);
}

export function deriveTargetRevisionFromBase(
  input: DeriveTargetRevisionInput,
  base: TargetSet,
  formulaName: string,
  floorsBound: EnergyFloorBound[] = [],
): TargetRevision & { floorsBound: EnergyFloorBound[] } {
  effectiveDate(input.today);
  if (!isProfileComplete(input.settings)) {
    throw new Error("Cannot derive targets from an incomplete profile");
  }
  const weightKg = weightForTargets(input.settings, input.latestWeighInKg);
  if (weightKg === null) throw new Error("Cannot derive targets without a weight");
  const trainingWeekdays = [...new Set(input.trainingWeekdays)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  const pins: TargetPins = {
    trainingKcal: input.settings.trainingKcal,
    restKcal: input.settings.restKcal,
    proteinG: input.settings.proteinG,
  };
  const targets = applyTargetPins(base, pins);
  const previousRevision = input.settings.activeTargetProfile?.revision;
  return {
    ...targets,
    floorsBound,
    revision: typeof previousRevision === "number" ? previousRevision + 1 : 1,
    source: input.source ?? "derived",
    effectiveFrom: input.today,
    pins,
    inputs: {
      effectiveDate: input.today,
      weightKg,
      weightSource: input.latestWeighInKg == null ? "onboarding" : "weigh-in",
      trainingWeekdays,
      activity: input.settings.activityLevel,
      goal: input.settings.goal,
      goalRateBpWeek: input.settings.goalRateBpWeek ?? 0,
      formulaName,
    },
  };
}

export function deriveTargetRevision(
  input: DeriveTargetRevisionInput,
): TargetRevision & {
  floorsBound: EnergyFloorBound[]; floors: TargetRevisionFloors; seed: TargetSeed;
} {
  if (!isProfileComplete(input.settings)) {
    throw new Error("Cannot derive targets from an incomplete profile");
  }
  const weightKg = weightForTargets(input.settings, input.latestWeighInKg);
  if (weightKg === null) throw new Error("Cannot derive targets without a weight");
  const profile = { ...energyProfileFrom(input.settings), weightKg };
  const trainingWeekdays = [...new Set(input.trainingWeekdays)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  const date = effectiveDate(input.today);
  const derived = deriveTargets(profile, date, trainingWeekdays.length);
  const seed: TargetSeed = {
    initialTdeeKcal: derived.rate.tdeeKcal,
    bmrKcal: Math.round(Number(bmr(profile, date).toFixed(6))),
    bmrMethod: bmrMethod(profile, date),
    activityModelVersion: ACTIVITY_MODEL_VERSION,
    derivationVersion: TARGET_DERIVATION_VERSION,
  };
  return {
    ...deriveTargetRevisionFromBase(
      { ...input, trainingWeekdays },
      derived,
      TARGET_FORMULA_NAME,
      derived.floorsBound,
    ),
    // The account's own minimum (step D): 4·protein + 9·50 + 4·100, never a sex floor.
    floors: {
      kcalMin: derived.rate.kcalMin,
      kcalMinSource: "macro_minimum",
      proteinGMin: derived.training.protein,
      fatGMin: PROFILE_FAT_G_MIN,
      carbGMin: PROFILE_CARB_G_MIN,
    },
    seed,
  };
}
