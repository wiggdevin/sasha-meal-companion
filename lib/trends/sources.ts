/**
 * Where the week's numbers come from on the phone (UI makeover §4.1): the account's own water rows
 * and water settings in IndexedDB, and one health window read that never touches the shared
 * `health_daily` cache. Each reader answers null when it cannot read, so a chart shows a gap or a
 * plain line, never a row of zeros.
 */
import type { AccountHandle } from "@/lib/device/account";
import { rethrowAccountChanged } from "@/lib/device/account";
import { fetchDaily } from "@/lib/health-client";
import type { DailyHealthRow } from "@/lib/health/contract";
import { allRows, getRow } from "@/lib/sync/idb";
import { USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import type { WaterGoalSettings } from "@/lib/water";
import { resolveWaterGoal, waterWeightKg } from "@/lib/water-goal";
import { waterPrefsOfDietPrefs } from "@/lib/water-prefs";
import type { DayType } from "@/lib/types";

/** The stored cups of every date in `dates` that has a water row. */
export async function readWaterWindow(h: AccountHandle, dates: readonly string[]): Promise<Map<string, number> | null> {
  try {
    const wanted = new Set(dates);
    const out = new Map<string, number>();
    for (const row of await allRows(h, "water_log")) {
      const date = typeof row.local_date === "string" ? row.local_date : null;
      const cups = row.cups === null || row.cups === undefined ? NaN : Number(row.cups);
      if (date && Number.isFinite(cups) && wanted.has(date) && !row.deleted_at) out.set(date, cups);
    }
    return out;
  } catch (e) {
    rethrowAccountChanged(e);
    return null;
  }
}

type SettingsRow = Record<string, unknown> & WaterGoalSettings;

/**
 * The water goal for a date's day type, from the synced settings row (manual or auto from the
 * profile weight, `resolveWaterGoal`). Null when the row cannot be read.
 */
export async function readWaterGoal(h: AccountHandle): Promise<((date: string, dayType: DayType) => number) | null> {
  try {
    const row = (await getRow(h, "user_settings", USER_SETTINGS_KEY)) as SettingsRow | undefined;
    if (!row) return null;
    const stored: WaterGoalSettings = {
      water_goal_cups: row.water_goal_cups ?? null,
      water_goal_cups_training: row.water_goal_cups_training ?? null,
      water_goal_cups_rest: row.water_goal_cups_rest ?? null,
    };
    const prefs = waterPrefsOfDietPrefs(row.diet_prefs);
    const weightKg = waterWeightKg(row.weight_kg);
    return (_date, dayType) => resolveWaterGoal({ dayType, stored, prefs, weightKg }).cups;
  } catch (e) {
    rethrowAccountChanged(e);
    return null;
  }
}

export type HealthWindow =
  | { status: "ok"; rows: DailyHealthRow[] }
  /** Health is switched off for this deployment (503). */
  | { status: "off" }
  /** The read failed (offline or an error): nothing to show, and nothing cached is passed off as it. */
  | { status: "unavailable" };

/** One health read for the window, `cache: false` (never overwrites the Body card's window). */
export async function readHealthWindow(h: AccountHandle, from: string, to: string,
  opts: { fetchImpl?: typeof fetch } = {}): Promise<HealthWindow> {
  const out = await fetchDaily(h, from, to, { cache: false, fetchImpl: opts.fetchImpl });
  if (out.disabled) return { status: "off" };
  if (!out.response) return { status: "unavailable" };
  return { status: "ok", rows: out.response.days };
}

/** True when any row of the window carries the field: a source exists for it. */
export function hasHealthField(rows: readonly DailyHealthRow[],
  field: "sleep_minutes" | "active_kcal" | "steps" | "body_mass_kg"): boolean {
  return rows.some((row) => typeof row[field] === "number" && Number.isFinite(row[field]));
}
