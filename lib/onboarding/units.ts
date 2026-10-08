/**
 * Onboarding v2 units (2026-10-07 live QA: "all users are in the US and still kg and cm were
 * used"). The phone asks and answers in feet/inches and pounds; storage stays metric
 * (`user_settings.height_cm`, `weight_kg`, the `body_mass` sample in kg). An account that already
 * chose cm or kg keeps its choice; nothing here infers a unit from a zone, a locale or a country.
 *
 * Pure. No I/O.
 */
import { kgToLb, lbToKg, LB_PER_KG, type WeightUnit } from "@/lib/health/units";
import {
  CM_MAX, CM_MIN, cmToFtIn, ftInToCm, isValidFtIn, type HeightUnit,
} from "@/lib/units/height";
import type { Settings } from "@/lib/types";

export type OnboardingUnits = { height: HeightUnit; weight: WeightUnit };

/** Imperial unless the account itself already chose metric. */
export const ONBOARDING_DEFAULT_UNITS: OnboardingUnits = { height: "ft_in", weight: "lb" };

export function onboardingUnitsFor(
  settings: Pick<Settings, "heightUnit" | "weightUnit"> | null | undefined,
): OnboardingUnits {
  return {
    height: settings?.heightUnit ?? ONBOARDING_DEFAULT_UNITS.height,
    weight: settings?.weightUnit ?? ONBOARDING_DEFAULT_UNITS.weight,
  };
}

const KG_MIN = 20;
const KG_MAX = 400;

const validCm = (cm: number) => Number.isFinite(cm) && cm >= CM_MIN && cm <= CM_MAX;
const validKg = (kg: number) => Number.isFinite(kg) && kg >= KG_MIN && kg <= KG_MAX;

/** The two fields a ft + in editor shows for a stored height. */
export function heightFields(cm: number | null | undefined): { ft: number; in: number } | null {
  return typeof cm === "number" && validCm(cm) ? cmToFtIn(cm) : null;
}

/** cm to store from a ft + in editor, or null when the pair is not a real height. */
export function cmFromHeightFields(ft: number, inches: number): number | null {
  if (!isValidFtIn(ft, inches)) return null;
  const cm = ftInToCm(ft, inches);
  return validCm(cm) ? cm : null;
}

/** The text a weight field shows: pounds to 0.1, kilograms as stored (to 0.1). */
export function weightFieldValue(kg: number | null | undefined, unit: WeightUnit): string {
  if (typeof kg !== "number" || !validKg(kg)) return "";
  const value = unit === "lb" ? kgToLb(kg) : kg;
  return String(Math.round(value * 10) / 10);
}

/** kg to store from a weight field in `unit`, or null when it is not a real body weight. */
export function kgFromWeightField(value: string | number, unit: WeightUnit): number | null {
  const raw = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const kg = unit === "lb" ? lbToKg(raw) : Math.round(raw * 1000) / 1000;
  return validKg(kg) ? kg : null;
}

/** "5 ft 5 in" or "165 cm". Empty string for no value. */
export function displayHeight(cm: number | null | undefined, unit: HeightUnit): string {
  const fields = unit === "ft_in" ? heightFields(cm) : null;
  if (fields) return `${fields.ft} ft ${fields.in} in`;
  return typeof cm === "number" && validCm(cm) ? `${Math.round(cm * 10) / 10} cm` : "";
}

/** "5′5″" — the compact form a sentence chip uses. */
export function displayHeightShort(cm: number | null | undefined, unit: HeightUnit): string {
  const fields = unit === "ft_in" ? heightFields(cm) : null;
  if (fields) return `${fields.ft}′${fields.in}″`;
  return displayHeight(cm, unit);
}

/** "150 lb" or "68 kg" (whole numbers; a chip never needs the decimal). */
export function displayWeight(kg: number | null | undefined, unit: WeightUnit): string {
  if (typeof kg !== "number" || !validKg(kg)) return "";
  return unit === "lb" ? `${Math.round(kg * LB_PER_KG)} lb` : `${Math.round(kg)} kg`;
}

const FT_IN = /^(\d)\s*(?:'|′|ft\.?|feet|foot)\s*(?:(\d{1,2})\s*(?:"|''|″|in\.?|inch(?:es)?)?)?$/;
const INCHES = /^(\d{2})\s*(?:"|″|in\.?|inch(?:es)?)$/;
const CM = /^(\d{2,3}(?:\.\d+)?)\s*(?:cm|centimet(?:er|re)s?)$/;
const M = /^([12](?:\.\d{1,2})?)\s*(?:m|met(?:er|re)s?)$/;

/**
 * One typed height: 5'5", 5 ft 5, 5'5, 65 in, 165 cm, 1.65 m. A bare number is read in the
 * field's own unit: feet when ft_in and it is 3-8 ("5" is 5 ft 0 in), cm when cm.
 */
export function parseHeightInput(text: string, unit: HeightUnit): number | null {
  const value = String(text ?? "").trim().toLowerCase().replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"");
  if (!value) return null;
  const ftIn = FT_IN.exec(value);
  if (ftIn) return cmFromHeightFields(Number(ftIn[1]), Number(ftIn[2] ?? 0));
  const inches = INCHES.exec(value);
  if (inches) {
    const total = Number(inches[1]);
    return cmFromHeightFields(Math.floor(total / 12), total % 12);
  }
  const cm = CM.exec(value);
  if (cm) return validCm(Number(cm[1])) ? Math.round(Number(cm[1]) * 10) / 10 : null;
  const m = M.exec(value);
  if (m) return validCm(Number(m[1]) * 100) ? Math.round(Number(m[1]) * 1000) / 10 : null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (unit === "ft_in") return Number.isInteger(n) ? cmFromHeightFields(n, 0) : null;
    return validCm(n) ? Math.round(n * 10) / 10 : null;
  }
  return null;
}

/** One typed weight: "150", "150 lb", "150 lbs", "68 kg". A bare number is in the field's unit. */
export function parseWeightInput(text: string, unit: WeightUnit): number | null {
  const value = String(text ?? "").trim().toLowerCase();
  const match = /^(\d{2,3}(?:[.,]\d+)?)\s*(lbs?|pounds?|kgs?|kilos?|kilograms?)?$/.exec(value);
  if (!match) return null;
  const stated = match[2];
  const inUnit: WeightUnit = !stated ? unit : stated.startsWith("k") ? "kg" : "lb";
  return kgFromWeightField(match[1], inUnit);
}

/** A typed age to the birth year the profile stores ("born ~YYYY"); 13-100 only. */
export function birthYearFromAge(age: number, now: Date = new Date()): number | null {
  if (!Number.isInteger(age) || age < 13 || age > 100) return null;
  return now.getFullYear() - age;
}

/** The age a stored birth year reads as this year, for the "how old are you?" echo. */
export function ageFromBirthYear(birthYear: number | null | undefined, now: Date = new Date()): number | null {
  if (typeof birthYear !== "number" || !Number.isInteger(birthYear)) return null;
  const age = now.getFullYear() - birthYear;
  return age >= 13 && age <= 100 ? age : null;
}
