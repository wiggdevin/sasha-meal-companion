/**
 * T6: the whole water kind of the export.
 *
 * `streamWater` used to sit in export.ts, which is over the 400-line house limit, so the complete
 * water implementation lives here and export.ts re-exports it (`streamWater`, `WATER_COLUMNS`,
 * `waterRowValues`, `WaterExportRow`) — `@/lib/server/export` stays the one import site.
 *
 * `goal` has to agree with Today, and Today resolves the day through `dayTypeFor(date, override)`
 * — so a date the user locked as a rest day (T5, `plan_days.day_type_override`) must export the
 * rest-day goal, not the weekday default.
 *
 * 2026-10-03: the goal is the same `resolveWaterGoal` Today calls (lib/water-goal.ts): auto from
 * body weight unless the account is in manual mode. The server's weight is the active target
 * revision's input weight (the latest weigh-in when the plan was derived), then the profile weight.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dayTypeFor } from "@/lib/plan";
import { activeProfile } from "@/lib/server/targets";
import type { WaterGoalSettings } from "@/lib/water";
import { resolveWaterGoal, waterWeightKg } from "@/lib/water-goal";
import { waterPrefsOfDietPrefs } from "@/lib/water-prefs";
import { decodeTextCursor, encodeTextCursor } from "@/lib/server/export-cursor";
import type { ExportJson, ExportOpts } from "@/lib/server/export";
import type { DayType } from "@/lib/types";

type OverrideRow = { local_date: string; day_type_override: string | null };

/** `plan_days` rows → date → the locked day type. A row with no override is not a fact. */
export function dayTypeOverrides(rows: readonly OverrideRow[] | null | undefined): Map<string, DayType> {
  const byDate = new Map<string, DayType>();
  for (const row of rows ?? []) {
    if (row.day_type_override) byDate.set(row.local_date, row.day_type_override as DayType);
  }
  return byDate;
}

/** The `plan_days` rows for exactly these dates, so the query never scans the whole history. */
export async function loadWaterOverrides(
  client: SupabaseClient, userId: string, dates: readonly string[],
): Promise<Map<string, DayType>> {
  if (dates.length === 0) return new Map();
  const { data, error } = await client.from("plan_days")
    .select("local_date, day_type_override").eq("user_id", userId).in("local_date", [...dates]);
  if (error) throw error;
  return dayTypeOverrides(data as OverrideRow[] | null);
}

export type ExportWaterGoals = {
  goal_training_cups: number;
  goal_rest_cups: number;
  forDate: (localDate: string) => number;
};

type WaterSettingsRow = WaterGoalSettings & {
  training_weekdays?: number[] | null;
  weight_kg?: number | string | null;
  diet_prefs?: unknown;
};

/** Both day-type goals, plus the goal that applies to any date the caller asks about. */
export function waterGoalsFor(
  settings: WaterSettingsRow | null | undefined,
  overrides: ReadonlyMap<string, DayType>,
  revisionWeightKg?: number | string | null,
): ExportWaterGoals {
  const stored = settings ?? undefined;
  const prefs = waterPrefsOfDietPrefs(stored?.diet_prefs);
  const weightKg = waterWeightKg(revisionWeightKg, stored?.weight_kg);
  const goal = (dayType: DayType) => resolveWaterGoal({ dayType, stored, prefs, weightKg }).cups;
  return {
    goal_training_cups: goal("training-10"),
    goal_rest_cups: goal("rest"),
    forDate: (localDate) => goal(dayTypeFor(localDate, overrides.get(localDate),
      { trainingWeekdays: stored?.training_weekdays })),
  };
}

export type WaterExportRow = { local_date: string; cups: number; goal: number;
  goal_training_cups: number; goal_rest_cups: number };

export const WATER_COLUMNS = ["local_date", "cups", "goal", "goal_training_cups",
  "goal_rest_cups"];

export function waterRowValues(row: WaterExportRow): (string | number | null)[] {
  return WATER_COLUMNS.map((c) =>
    (row as unknown as Record<string, string | number | null>)[c] ?? null);
}

export async function streamWater(
  client: SupabaseClient, userId: string, opts: ExportOpts,
): Promise<ExportJson<WaterExportRow>> {
  let query = client.from("water_log").select("local_date, cups").eq("user_id", userId);
  if (opts.from) query = query.gte("local_date", opts.from);
  if (opts.to) query = query.lte("local_date", opts.to);
  if (opts.cursor) query = query.gt("local_date", decodeTextCursor(opts.cursor));
  const [days, settings, revision] = await Promise.all([
    query.order("local_date", { ascending: true }).limit(opts.limit + 1),
    client.from("user_settings")
      .select("water_goal_cups, water_goal_cups_training, water_goal_cups_rest, training_weekdays, "
        + "weight_kg, diet_prefs")
      .eq("user_id", userId).maybeSingle(),
    activeProfile(client, userId),
  ]);
  if (days.error) throw days.error;
  if (settings.error) throw settings.error;

  const all = (days.data ?? []) as { local_date: string; cups: number }[];
  const hasMore = all.length > opts.limit;
  const page = hasMore ? all.slice(0, opts.limit) : all;
  // T6: both goals travel, and `goal` is that date's goal after any per-date lock (T5) — the same
  // answer Today gives.
  const overrides = await loadWaterOverrides(client, userId, page.map((d) => d.local_date));
  const goals = waterGoalsFor(settings.data as WaterSettingsRow | null, overrides, revision?.input_weight_kg);
  const rows = page.map((d) => ({ local_date: d.local_date, cups: Number(d.cups),
    goal: goals.forDate(d.local_date), goal_training_cups: goals.goal_training_cups,
    goal_rest_cups: goals.goal_rest_cups }));
  const last = page.at(-1);
  return { rows, notices: [],
    next_cursor: hasMore && last ? encodeTextCursor(last.local_date) : null };
}
