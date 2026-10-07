import type { ActivityLevel, BodyFatSource, Goal, Macros, Settings } from "../types";
import { macroMinimumKcal, proteinBasisKg, rateTarget, validateRate, type RateTarget }
  from "./rate-goal";

export type EnergyProfile = {
  sex: "female" | "male" | "unspecified";
  birthYear: number;
  heightCm: number;
  weightKg: number;
  bodyFatPct?: number | null;
  bodyFatSource?: BodyFatSource | null;
  bodyFatMeasuredOn?: string | null;
  activityLevel: ActivityLevel;
  goal: Goal;
  /** Basis points of body weight per week (step D); 0 for an account that never confirmed one. */
  goalRateBpWeek: number;
};

type DayKind = "training" | "rest";
export type EnergyFloorBound = `${DayKind}:${"kcal" | "carbs" | "fat"}`;
/** What the rate did to the number, for the clamp copy and the revision's `kcal_min`. */
export type RateOutcome = RateTarget & { tdeeKcal: number; kcalMin: number };
export type DerivedTargets = {
  training: Macros;
  rest: Macros;
  floorsBound: EnergyFloorBound[];
  rate: RateOutcome;
};

type CompleteProfileSettings = Settings & {
  sex: "female" | "male" | "unspecified";
  birthYear: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: Goal;
};

/**
 * Conservative starting factors (ruling 2026-09-22, docs/decisions/2026-09-22-target-priors.md).
 * The classic 1.2 / 1.375 / 1.55 / 1.725 / 1.9 table stayed until 2026-09-22 because 1.55 was
 * the first client's MEASURED trained maintenance (analysis/targets.md §1: 127 lb, 19.5 % BF by
 * InBody, on the client's feet all day, four lifting sessions); it over-estimated everyone else
 * by ~200 kcal/day at "moderate".
 * These are priors the expenditure engine is meant to replace, so they err low, never high.
 */
const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.3,
  moderate: 1.4,
  active: 1.55,
  very_active: 1.7,
};

const FAT_G_MIN = 50;
const CARB_G_MIN = 100;

/**
 * Mifflin-St Jeor's sex term (onboarding v2, "prefer not to say", coordinator ruling
 * 2026-10-06): male 5, female -161. `unspecified` is their exact midpoint, (5 + -161) / 2 = -78
 * — not a guess at either sex, so male and female results are byte-identical to before this
 * value existed. Katch-McArdle (body-fat-driven) needs no sex term at all, so this only reaches
 * the Mifflin branch of `bmr` below.
 */
const SEX_BMR_TERM: Record<EnergyProfile["sex"], number> = {
  male: 5,
  female: -161,
  unspecified: -78,
};

export function activityFactor(level: ActivityLevel): number {
  return ACTIVITY_FACTORS[level];
}

/** Sources that measure body composition well enough for Katch-McArdle (step C ruling). */
const MEASURED_SOURCES: ReadonlySet<BodyFatSource> = new Set(["dexa", "inbody", "clinical_bia"]);
export const KATCH_MAX_AGE_DAYS = 180;

type BodyFatProvenance = Pick<EnergyProfile, "bodyFatPct" | "bodyFatSource" | "bodyFatMeasuredOn">;

/** A real calendar day as YYYY-MM-DD, or null: one parser for every reader of a scan date. */
export function isoDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const parsed = new Date(Date.UTC(year, month, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month
    && parsed.getUTCDate() === day ? value.slice(0, 10) : null;
}

/**
 * Katch-McArdle only for a measured value dated within 180 days of `today`. A typed guess, a
 * consumer scale or a stale scan makes Katch less accurate than Mifflin-St Jeor, so each of
 * those — and a missing, future or malformed date — falls back to Mifflin.
 */
export function katchEligible(profile: BodyFatProvenance, today: Date): boolean {
  if (typeof profile.bodyFatPct !== "number") return false;
  if (!profile.bodyFatSource || !MEASURED_SOURCES.has(profile.bodyFatSource)) return false;
  const measuredOn = isoDay(profile.bodyFatMeasuredOn);
  if (measuredOn === null) return false;
  // UTC calendar days: every caller passes noon UTC (derive.ts effectiveDate, profile-tdee.ts),
  // which is the same calendar day in every zone within ±12 h.
  const ageDays = (Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    - Date.parse(`${measuredOn}T00:00:00Z`)) / 86_400_000;
  return ageDays >= 0 && ageDays <= KATCH_MAX_AGE_DAYS;
}

/**
 * The Settings-level twin of `withBodyFatProvenance` (lib/sync/user-settings.ts) and the
 * `user_settings_body_fat_provenance` trigger: a new or cleared value drops the old scan label
 * unless the same change sets a new one. Applied BEFORE a derivation, so a new typed number never
 * reaches the targets route still labelled as a scan.
 */
export function settingsWithBodyFatProvenance<T extends BodyFatProvenance>(before: T, after: T): T {
  const cleared = after.bodyFatPct === null || after.bodyFatPct === undefined;
  const same = (key: keyof BodyFatProvenance) => (after[key] ?? null) === (before[key] ?? null);
  if (!cleared && (same("bodyFatPct") || !same("bodyFatSource") || !same("bodyFatMeasuredOn"))) {
    return after;
  }
  return { ...after, bodyFatSource: null, bodyFatMeasuredOn: null };
}

/** The label for the activity table above; a change to any factor is a new version. */
export const ACTIVITY_MODEL_VERSION = "activity-2026-09-22";

export function bmrMethod(profile: EnergyProfile, today: Date): "mifflin" | "katch" {
  return katchEligible(profile, today) && typeof profile.bodyFatPct === "number"
    ? "katch" : "mifflin";
}

export function bmr(profile: EnergyProfile, today: Date): number {
  if (bmrMethod(profile, today) === "katch" && typeof profile.bodyFatPct === "number") {
    const leanBodyMassKg = profile.weightKg * (1 - profile.bodyFatPct / 100);
    return 370 + 21.6 * leanBodyMassKg;
  }
  const age = today.getFullYear() - profile.birthYear;
  return 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * age + SEX_BMR_TERM[profile.sex];
}

export function tdee(profile: EnergyProfile, today: Date): number {
  return bmr(profile, today) * activityFactor(profile.activityLevel);
}

function atwater(protein: number, carbs: number, fat: number): number {
  return 4 * protein + 4 * carbs + 9 * fat;
}

function macros(protein: number, carbs: number, fat: number): Macros {
  return { protein, carbs, fat, kcal: atwater(protein, carbs, fat) };
}

function cycledCarbs(baseCarbs: number, trainingDays: number): {
  training: number;
  rest: number;
} {
  const restDays = 7 - trainingDays;
  if (trainingDays === 0 || restDays === 0) {
    return { training: baseCarbs, rest: baseCarbs };
  }

  const exactTraining = baseCarbs * 1.1;
  const exactRest = baseCarbs * (1 - (0.1 * trainingDays / restDays));
  const roundedTraining = Math.round(exactTraining);
  const rank = ({ training, rest }: { training: number; rest: number }): number => {
    const weeklyError = Math.abs(
      trainingDays * training + restDays * rest - 7 * baseCarbs) * 4 / 7;
    const rounding = Math.abs(training - exactTraining) + Math.abs(rest - exactRest);
    return weeklyError <= 1 ? rounding : 1_000 + weeklyError;
  };
  let best = { training: roundedTraining, rest: Math.round(exactRest) };
  // Integer grams can otherwise miss the weekly-average base by more than 1 kcal. Because the day
  // counts are coprime factors of seven, one of the nearest three training values can absorb it.
  for (let delta = -3; delta <= 3; delta += 1) {
    const training = roundedTraining + delta;
    const rest = Math.round((7 * baseCarbs - trainingDays * training) / restDays);
    const candidate = { training, rest };
    if (rank(candidate) < rank(best)) best = candidate;
  }
  return best;
}

/** `trainingDays` is required: a silent four-day default was the first client's week, not a
 *  neutral one (ruling 2026-09-22). derive.ts passes the account's explicit weekdays. */
export function deriveTargets(
  profile: EnergyProfile,
  today: Date,
  trainingDays: number,
): DerivedTargets {
  // 0 is also "no rate confirmed yet": an existing account derives at maintenance until the
  // user picks one (ruling 2026-09-22). Any other value must be a preset for the goal.
  if (profile.goalRateBpWeek !== 0 && !validateRate(profile.goal, profile.goalRateBpWeek)) {
    throw new Error(`Goal rate ${profile.goalRateBpWeek} bp/week is not a preset for ${profile.goal}`);
  }
  // Protein first: the account's own minimum is 4·protein + 9·50 + 4·100, and that minimum, not
  // a 1,200 / 1,500 kcal sex floor, is the lowest the rate may take the number (ruling 2026-09-22).
  const proteinFactor = profile.goal === "lose_fat" || profile.goal === "recomp" ? 2 : 1.8;
  const protein = Math.round(proteinBasisKg(profile.weightKg, profile.heightCm) * proteinFactor);
  const kcalMin = macroMinimumKcal({ proteinGMin: protein, fatGMin: FAT_G_MIN,
    carbGMin: CARB_G_MIN });
  // Whole kcal after squashing float noise: 1,337.5 × 1.4 is 1,872.4999… in IEEE arithmetic and
  // must round to the ruling's 1,873, not 1,872.
  const tdeeKcal = Math.round(Number(tdee(profile, today).toFixed(6)));
  const rate: RateOutcome = { ...rateTarget({ tdeeKcal, weightBasisKg: profile.weightKg,
    goalRateBpWeek: profile.goalRateBpWeek, kcalMin }), tdeeKcal, kcalMin };
  const targetKcal = rate.targetKcal;
  const rawFat = Math.round(0.25 * targetKcal / 9);
  const fat = Math.max(FAT_G_MIN, rawFat);
  const baseCarbs = Math.round((targetKcal - 4 * protein - 9 * fat) / 4);
  const restDays = 7 - trainingDays;
  const carbs = cycledCarbs(baseCarbs, trainingDays);
  const floorsBound: EnergyFloorBound[] = [];
  const dayAtFloor = (
    kind: DayKind,
    cycledCarbs: number,
    isScheduled: boolean,
  ): Macros => {
    if (isScheduled && rawFat < FAT_G_MIN) floorsBound.push(`${kind}:fat`);
    if (isScheduled && cycledCarbs < CARB_G_MIN) floorsBound.push(`${kind}:carbs`);
    // With protein fixed and the fat and carb floors held, a day can never sit below kcalMin;
    // the calorie bound is the rate's own, reported for every scheduled day.
    if (isScheduled && rate.bound === "kcal_min") floorsBound.push(`${kind}:kcal`);
    return macros(protein, Math.max(CARB_G_MIN, cycledCarbs), fat);
  };
  const training = dayAtFloor("training", carbs.training, trainingDays > 0);
  const rest = dayAtFloor("rest", carbs.rest, restDays > 0);

  if (training.kcal !== atwater(training.protein, training.carbs, training.fat)
    || rest.kcal !== atwater(rest.protein, rest.carbs, rest.fat)
    || training.kcal < kcalMin || rest.kcal < kcalMin) {
    throw new Error("Derived target calorie identity failed");
  }
  return { training, rest, floorsBound, rate };
}

export function isProfileComplete(settings: Settings): settings is CompleteProfileSettings {
  return (settings.sex === "female" || settings.sex === "male" || settings.sex === "unspecified")
    && typeof settings.birthYear === "number"
    && typeof settings.heightCm === "number"
    && typeof settings.weightKg === "number"
    && settings.activityLevel != null
    && settings.goal != null;
}

export function energyProfileFrom(settings: Settings): EnergyProfile {
  if (!isProfileComplete(settings)) {
    throw new Error("Cannot build an energy profile from incomplete settings");
  }
  return {
    sex: settings.sex,
    birthYear: settings.birthYear,
    heightCm: settings.heightCm,
    weightKg: settings.weightKg,
    bodyFatPct: settings.bodyFatPct ?? null,
    bodyFatSource: settings.bodyFatSource ?? null,
    bodyFatMeasuredOn: settings.bodyFatMeasuredOn ?? null,
    activityLevel: settings.activityLevel,
    goal: settings.goal,
    // An account that never confirmed a rate derives at maintenance: no silent backfill.
    goalRateBpWeek: settings.goalRateBpWeek ?? 0,
  };
}

export function weightForTargets(
  settings: Pick<Settings, "weightKg">,
  latestWeighInKg?: number | null,
): number | null {
  return latestWeighInKg ?? settings.weightKg ?? null;
}
