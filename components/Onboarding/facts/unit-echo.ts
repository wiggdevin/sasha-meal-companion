/**
 * Onboarding v2 — how the facts read back to the person. Every account is in the US (owner,
 * 2026-10-07), so the person only ever sees imperial: feet and inches, pounds, an age. Metric stays
 * the stored value underneath (`heightCm`, `weightKg`, `birthYear`); nothing here is shown in cm or
 * kg. Pure formatting over the existing `lib/units/height.ts` and `lib/health/units.ts` helpers so
 * a unit bug has one owner.
 */
import { cmToFtIn } from "@/lib/units/height";
import { kgToLb } from "@/lib/health/units";

/** 178 → `5′10″`. */
export function heightImperial(heightCm: number): string {
  const { ft, in: inches } = cmToFtIn(heightCm);
  return `${ft}′${inches}″`;
}

/** 75 → `165 lb`. */
export function weightImperial(weightKg: number): string {
  return `${Math.round(kgToLb(weightKg))} lb`;
}

/** The age a birth year stands for today (the birthday is not asked, so this is the year's age). */
export function ageFromBirthYear(birthYear: number, today = new Date()): number {
  return today.getUTCFullYear() - birthYear;
}

export function birthYearFromAge(age: number, today = new Date()): number {
  return today.getUTCFullYear() - age;
}
