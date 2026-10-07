/**
 * Display-only profile formula and health-window helpers.
 *
 * DISPLAY ONLY. Nothing here is on the target path and nothing here may join it: `analysis/
 * targets.md` still owns every calorie number, and the weekly proposal is still the only thing
 * that changes a target. `lib/tdee.test.ts` greps the target path for an import of this file.
 *
 * The profile-derived TDEE used by surfaces now comes from the target-authority API. These pure
 * BMR and observation helpers remain for compatibility and never turn device energy into TDEE.
 */
import type { DailyHealthRow } from "@/lib/health/contract";

export type Sex = "female" | "male" | "unspecified";

/** The four nullable `user_settings` columns of T11b, as one value object. */
export type BodyProfile = { heightCm: number | null; birthYear: number | null; sex: Sex | null;
  bodyFatPct: number | null };

export const EMPTY_BODY_PROFILE: BodyProfile = { heightCm: null, birthYear: null, sex: null,
  bodyFatPct: null };

/**
 * What a surface KNOWS about the stored profile (T11b eighth-round finding 5). `ready` carries the
 * profile — which may be empty, and that emptiness is a fact about the row. `unavailable` is what a
 * failed (or not-yet-landed) read leaves: the profile is UNKNOWN, and the lines that stand on it are
 * withheld rather than rendered as "Add height, birth year and sex in Settings", which would make
 * a claim about profile data instead of acknowledging a read gap.
 */
export type ProfileState =
  | { status: "ready"; profile: BodyProfile | null }
  | { status: "unavailable" };

/** The profile is not known: the read failed, or has not answered yet. */
export const PROFILE_UNAVAILABLE: ProfileState = { status: "unavailable" };

/** A known profile — possibly an empty one. */
export function profileState(profile: BodyProfile | null): ProfileState {
  return { status: "ready", profile };
}

export const ACTIVITY_WINDOW_DAYS = 7;
export const WEIGHT_MAX_AGE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** Sol r3 NIT: "unspecified" takes the exact midpoint (-78), same as lib/profile/energy.ts
 *  SEX_BMR_TERM — this display-only twin has no runtime caller today, but a ternary that
 *  silently fell through to the male term for it would be wrong the moment one appears. */
export function bmrMifflinStJeor(weightKg: number, heightCm: number, ageYears: number,
    sex: Sex): number {
  const sexTerm = sex === "female" ? -161 : sex === "unspecified" ? -78 : 5;
  return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + sexTerm;
}

/** 370 + 21.6 × lean body mass, so body-fat % replaces the height/age/sex inputs entirely. */
export function bmrKatchMcArdle(weightKg: number, bodyFatPct: number): number {
  return 370 + 21.6 * weightKg * (1 - bodyFatPct / 100);
}

/** Whole years between the birth year and the local date. The formula wants a number, not a party. */
export function ageYears(birthYear: number, localDate: string): number {
  return Number(localDate.slice(0, 4)) - birthYear;
}

function daysAgo(localDate: string, iso: string): number {
  return Math.round((Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`))
    / MS_PER_DAY);
}

function inWindow(day: DailyHealthRow, localDate: string, windowDays: number): boolean {
  const age = daysAgo(localDate, day.local_date);
  return age >= 0 && age < windowDays;
}

/** The latest weigh-in inside 14 days of `localDate`, or null when the line has nothing to stand on. */
export function latestWeightKg(days: readonly DailyHealthRow[], localDate: string): number | null {
  let latest: { date: string; kg: number } | null = null;
  for (const day of days) {
    if (day.body_mass_kg === null || !inWindow(day, localDate, WEIGHT_MAX_AGE_DAYS + 1)) continue;
    if (latest === null || day.local_date > latest.date) {
      latest = { date: day.local_date, kg: day.body_mass_kg };
    }
  }
  return latest?.kg ?? null;
}

export type ActiveEnergy = { avgKcal: number; daysWithData: number; sourceKinds: string[] };

/**
 * Mean of the days in the last 7 that carry active energy, plus the source kinds behind it.
 *
 * The attribution is the `provenance.active_energy.kind` alone, newest day first — never the
 * day's whole `sources` list (Sol audit finding 6). A day can carry Oura sleep and Apple active
 * energy at once, and the line must name the device that produced the energy it is showing.
 */
export function activeEnergy7d(days: readonly DailyHealthRow[], localDate: string): ActiveEnergy {
  const measured = days.filter((day) => day.active_kcal !== null
    && inWindow(day, localDate, ACTIVITY_WINDOW_DAYS));
  const total = measured.reduce((sum, day) => sum + (day.active_kcal ?? 0), 0);
  const newestFirst = [...measured].sort((a, b) => (a.local_date < b.local_date ? 1 : -1));
  const sourceKinds: string[] = [];
  for (const day of newestFirst) {
    const kind = day.provenance?.active_energy?.kind;
    if (kind && !sourceKinds.includes(kind)) sourceKinds.push(kind);
  }
  return {
    avgKcal: measured.length === 0 ? 0 : total / measured.length,
    daysWithData: measured.length,
    sourceKinds,
  };
}

// `formulaTdee` was removed in TDEE step E8 (docs/specs/phase-16-adaptive-handoff.md): it had no
// runtime caller, returned a BMR rather than a TDEE, and chose Katch-McArdle for any body fat. The
// one starting number every surface shows is the seed frozen on the target revision
// (lib/server/profile-tdee.ts `seedFor`).
