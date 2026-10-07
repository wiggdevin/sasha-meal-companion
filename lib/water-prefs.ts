/**
 * The account's water preferences, kept in the existing `user_settings.diet_prefs` JSON object
 * under `water` (beside `flags`, `text` and `lifestyle`), so they sync through the ordinary
 * settings op with no new column and no migration. Pure.
 *
 *   diet_prefs.water = { unit?: "oz" | "cups" | "ml", goal?: "auto" | "manual" }
 *
 * An absent key means "not chosen": the unit follows the browser locale (`defaultWaterUnit`) and
 * the goal mode is inferred from the stored goals (`waterGoalMode`, lib/water-goal.ts).
 */
import { browserLocale, defaultWaterUnit, isWaterUnit, type WaterUnit } from "./water-units";

export const WATER_GOAL_MODES = ["auto", "manual"] as const;
export type WaterGoalMode = (typeof WATER_GOAL_MODES)[number];
export type WaterPrefs = { unit?: WaterUnit; goal?: WaterGoalMode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The validated `water` object; anything unrecognised is dropped, never trusted. */
export function waterPrefsFrom(value: unknown): WaterPrefs {
  if (!isRecord(value)) return {};
  return {
    ...(isWaterUnit(value.unit) ? { unit: value.unit } : {}),
    ...(value.goal === "auto" || value.goal === "manual" ? { goal: value.goal } : {}),
  };
}

export function waterPrefsOfDietPrefs(dietPrefs: unknown): WaterPrefs {
  return isRecord(dietPrefs) ? waterPrefsFrom(dietPrefs.water) : {};
}

/**
 * The stored `diet_prefs` with `patch` merged into its `water` object. Every other key (`flags`,
 * `text`, `lifestyle`) is carried as stored; `flags` is materialised as an array because every
 * server reader of this column reads `diet_prefs.flags`.
 */
export function dietPrefsWithWater(dietPrefs: unknown, patch: WaterPrefs): Record<string, unknown> {
  const base = isRecord(dietPrefs) ? dietPrefs : {};
  const flags = Array.isArray(base.flags) ? base.flags.filter((flag) => typeof flag === "string") : [];
  return { ...base, flags, water: { ...waterPrefsFrom(base.water), ...waterPrefsFrom(patch) } };
}

/** The unit every readout uses: the account's choice, else the browser's locale default. */
export function waterUnitFor(prefs: WaterPrefs | undefined, locale: string | null = browserLocale()): WaterUnit {
  return prefs?.unit ?? defaultWaterUnit(locale);
}
