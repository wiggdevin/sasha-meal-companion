import { adjustCalories, type DayCategory } from "@/lib/scaling";
import {
  ACTIVITY_MODEL_VERSION, bmr, bmrMethod, deriveTargets, energyProfileFrom, isProfileComplete,
  weightForTargets,
} from "@/lib/profile/energy";
import type { EnergyFloorBound } from "@/lib/profile/energy";
import { macroMinimumKcal } from "@/lib/profile/rate-goal";
import {
  AdultOnlyError, isMinorOn, paceAllowed, standardProtein, type TargetEligibility,
} from "@/lib/profile/rate-eligibility";
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
const KCAL_PER_G_CARB = 4;
const KCAL_PER_G_FAT = 9;
const PROFILE_FAT_G_MIN = 50;
const PROFILE_CARB_G_MIN = 100;

export type DeriveTargetRevisionInput = {
  settings: Settings;
  latestWeighInKg: number | null;
  today: string;
  trainingWeekdays: readonly number[];
  source?: Extract<TargetSource, "derived" | "manual">;
  /**
   * The account's stored safety answers (lib/profile/rate-eligibility.ts). The server reads them
   * itself (lib/server/target-eligibility.ts) and never takes them from a request body. A hold
   * derives at a 0 pace; kidney disease also takes standard protein.
   */
  eligibility?: TargetEligibility;
  /**
   * Server recompute only (lib/server/target-recompute.ts): a revision with a pace is in force
   * for an account that is now under 18, and this derivation supersedes it on its own date at a
   * 0 pace (audit 2026-10-10 A094). It never builds a first plan for a minor, and it has no
   * effect for an adult.
   */
  supersedeForMinor?: boolean;
};

/**
 * The settings a derivation may use: under 18 on the revision's date (or the minor profile)
 * builds nothing, except a 0-pace supersede of a paced revision already in force; a held
 * account keeps its goal at a 0 pace (owner decisions 2026-10-08).
 */
export function eligibleSettings(input: DeriveTargetRevisionInput): Settings {
  const minor = isMinorOn(input.settings.birthYear, input.today) || !!input.eligibility?.minor;
  if (minor && !input.supersedeForMinor) throw new AdultOnlyError();
  return (paceAllowed(input.eligibility) && !minor) || !input.settings.goalRateBpWeek
    ? input.settings : { ...input.settings, goalRateBpWeek: 0 };
}

/** A pin makes the resolved numbers user-authored even when profile inputs trigger the recompute. */
export function targetSourceFor(
  settings: Pick<Settings, "trainingKcal" | "restKcal" | "proteinG">,
): Extract<TargetSource, "derived" | "manual"> {
  return settings.trainingKcal !== null || settings.restKcal !== null || settings.proteinG !== null
    ? "manual"
    : "derived";
}

/**
 * A pinned day never sits under the revision's own fat and carb floors (audit 2026-10-10 A002):
 * `adjustCalories` lowers a rest day's carbs to the older 80 g day floor, while every revision
 * records 100 g. The day is raised back to the floors, so its calories follow.
 */
function atRevisionFloors(day: Macros): Macros {
  const carbs = Math.max(day.carbs, PROFILE_CARB_G_MIN);
  const fat = Math.max(day.fat, PROFILE_FAT_G_MIN);
  if (carbs === day.carbs && fat === day.fat) return day;
  return { protein: day.protein, carbs, fat,
    kcal: day.protein * KCAL_PER_G_PROTEIN + carbs * KCAL_PER_G_CARB + fat * KCAL_PER_G_FAT };
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
  return atRevisionFloors(adjustCalories(baseline, kcalPin ?? base.kcal, category).macros);
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
  const settings = eligibleSettings(input);
  const weightKg = weightForTargets(settings, input.latestWeighInKg);
  if (weightKg === null) throw new Error("Cannot derive targets without a weight");
  const profile = { ...energyProfileFrom(settings), weightKg,
    ...(standardProtein(input.eligibility) ? { proteinStandard: true } : {}) };
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
  const revision = deriveTargetRevisionFromBase(
    { ...input, settings, trainingWeekdays },
    derived,
    TARGET_FORMULA_NAME,
    derived.floorsBound,
  );
  // The account's own minimum (step D): 4·protein + 9·50 + 4·100, never a sex floor. The protein
  // is the revision's own (a protein pin included), so a pinned day is never recorded under its
  // own minimum (audit 2026-10-10 A002); without a pin this is the derivation's kcalMin.
  const proteinGMin = revision.training.protein;
  return {
    ...revision,
    floors: {
      kcalMin: macroMinimumKcal({ proteinGMin, fatGMin: PROFILE_FAT_G_MIN,
        carbGMin: PROFILE_CARB_G_MIN }),
      kcalMinSource: "macro_minimum",
      proteinGMin,
      fatGMin: PROFILE_FAT_G_MIN,
      carbGMin: PROFILE_CARB_G_MIN,
    },
    seed,
  };
}
