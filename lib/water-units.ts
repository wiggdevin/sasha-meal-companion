/**
 * Water units (owner, 2026-10-03: "Is ounces better, or give the user the option"). Pure.
 *
 * Storage does not move: `water_log.cups` and the goal columns stay whole US cups, the canonical
 * unit. Every readout converts at render time. A cup is 8 US fl oz (exact) and 237 ml (236.6,
 * rounded), so ounces and cups map onto storage exactly and millilitres show the nearest ml. One
 * step on the tile is one cup in every unit (8 oz, 1 cup, 237 ml): a 250 ml step would need a
 * fractional column, which this does not add.
 */
import { OZ_PER_CUP } from "./water";

export const WATER_UNITS = ["oz", "cups", "ml"] as const;
export type WaterUnit = (typeof WATER_UNITS)[number];
export const ML_PER_CUP = 237;

export function isWaterUnit(value: unknown): value is WaterUnit {
  return typeof value === "string" && (WATER_UNITS as readonly string[]).includes(value);
}

/**
 * Ounces for everyone until the app serves accounts outside the US (owner, 2026-10-03: "everybody's in
 * the US, nobody knows millilitres"). Millilitres stay a choice in Settings. The locale is kept in
 * the signature so a regional default can return without touching callers.
 */
export function defaultWaterUnit(_locale?: string | null): WaterUnit {
  return "oz";
}

/** The browser's language tag, or null on the server. */
export function browserLocale(): string | null {
  return typeof navigator !== "undefined" && typeof navigator.language === "string" ? navigator.language : null;
}

/** Cups in the unit's own number, rounded the way the unit is read (whole oz and ml, tenth cups). */
export function waterValue(cups: number, unit: WaterUnit): number {
  const safe = Number.isFinite(cups) ? cups : 0;
  if (unit === "oz") return Math.round(safe * OZ_PER_CUP);
  if (unit === "ml") return Math.round(safe * ML_PER_CUP);
  return Math.round(safe * 10) / 10;
}

export function waterNumber(cups: number, unit: WaterUnit): string {
  return waterValue(cups, unit).toLocaleString("en-US");
}

export function unitWord(unit: WaterUnit, value: number): string {
  if (unit === "cups") return Math.abs(value) === 1 ? "cup" : "cups";
  return unit;
}

/** "64 oz", "1 cup", "8 cups", "1,896 ml". */
export function formatWater(cups: number, unit: WaterUnit): string {
  return `${waterNumber(cups, unit)} ${unitWord(unit, waterValue(cups, unit))}`;
}

/** "32 of 64 oz", "4 of 8 cups". The unit word follows the goal. */
export function formatWaterOf(cups: number, goal: number, unit: WaterUnit): string {
  return `${waterNumber(cups, unit)} of ${formatWater(goal, unit)}`;
}

/** "+48 oz", "−2 cups" (a true minus sign), "+0 oz". */
export function formatWaterDelta(cups: number, unit: WaterUnit): string {
  const sign = cups < 0 ? "−" : "+";
  return `${sign}${formatWater(Math.abs(cups), unit)}`;
}

/** What one step adds, as a phrase: "a cup", "8 oz", "237 ml". */
export function stepPhrase(unit: WaterUnit): string {
  return unit === "cups" ? "a cup" : formatWater(1, unit);
}

/** The step on the add pill: "Cup", "8 oz", "237 ml". */
export function stepLabel(unit: WaterUnit): string {
  return unit === "cups" ? "Cup" : formatWater(1, unit);
}

export const UNIT_NAMES: Record<WaterUnit, string> = { oz: "Ounces", cups: "Cups", ml: "Millilitres" };
