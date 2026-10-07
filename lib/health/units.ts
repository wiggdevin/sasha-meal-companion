/**
 * One canonical unit per sample type (spec §7). Storage is kilograms; the dashboard converts to
 * pounds at render time (contracts §2). An unrecognised unit throws: a silent pass-through would
 * store pounds in a kilogram column and no later code could tell.
 */
import type { SampleType } from "@/lib/health/contract";

export const LB_PER_KG = 2.2046226218;
export type WeightUnit = "lb" | "kg";
const KCAL_PER_KJ = 4.184;

const CANONICAL: Record<SampleType, string> = {
  body_mass: "kg", step_count: "count", active_energy: "kcal", basal_energy: "kcal",
  sleep_asleep: "min", sleep_in_bed: "min", resting_heart_rate: "bpm", hrv_sdnn: "ms",
  readiness_score: "score",
};

/**
 * Pounds to the kilograms the column stores, at three decimals (T8 §2). Three, not six: a typed
 * weigh-in is a number the user read off a scale to one decimal of a pound, and `170` and `170.0` must
 * produce the same stored value on any device.
 */
export function lbToKg(lb: number): number {
  return Math.round((lb / LB_PER_KG) * 1000) / 1000;
}

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG;
}

export function formatWeight(kg: number | null, unit: WeightUnit): string {
  if (kg === null || !Number.isFinite(kg)) return "—";
  const value = unit === "lb" ? kgToLb(kg) : kg;
  return `${Math.round(value * 10) / 10} ${unit}`;
}

export function canonicalUnit(type: SampleType): string {
  const unit = CANONICAL[type];
  if (!unit) throw new Error(`unknown sample type "${type}"`);
  return unit;
}

/** Six decimal places: enough for grams of body mass, short of float noise in a dedupe comparison. */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function toCanonical(type: SampleType, value: number, unit: string):
    { value: number; unit: string } {
  const target = canonicalUnit(type);
  const from = unit.trim();
  if (from === target) return { value: round6(value), unit: target };

  const lower = from.toLowerCase();
  if (target === "kg") {
    if (lower === "lb" || lower === "lbs") return { value: round6(value / LB_PER_KG), unit: target };
    if (lower === "g") return { value: round6(value / 1000), unit: target };
  }
  if (target === "min") {
    if (lower === "h" || lower === "hr" || lower === "hour" || lower === "hours") {
      return { value: round6(value * 60), unit: target };
    }
    if (lower === "s" || lower === "sec" || lower === "seconds") {
      return { value: round6(value / 60), unit: target };
    }
  }
  if (target === "kcal" && (lower === "kj" || lower === "kilojoules")) {
    return { value: round6(value / KCAL_PER_KJ), unit: target };
  }
  if (target === "ms" && (lower === "s" || lower === "sec")) {
    return { value: round6(value * 1000), unit: target };
  }
  throw new Error(`unknown unit "${unit}" for ${type}`);
}
