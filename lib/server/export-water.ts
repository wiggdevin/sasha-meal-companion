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
 * body weight unless the account is in manual mode.
 *
 * W012 (A052): each date is judged by the target revision in force ON THAT DATE, as the progress
 * export and Today judge it — its training weekdays set the day type and its input weight sizes the
 * auto goal, then the profile weight; a date before the account's first revision (or under a row
 * that does not parse) uses the profile's weekdays and weight. W012 (A085, A113): the rows are read past the API's 1,000-row cap
 * (`fetchUpTo`), so a page holds every row it says it holds and `next_cursor` is real.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TargetProfile } from "@/lib/api-types";
import { dayTypeFor } from "@/lib/plan";
import { targetsFromProfile } from "@/lib/server/targets";
import type { WaterGoalSettings } from "@/lib/water";
import { resolveWaterGoal, waterWeightKg } from "@/lib/water-goal";
import { waterPrefsOfDietPrefs } from "@/lib/water-prefs";
import { decodeDateCursor, encodeTextCursor } from "@/lib/server/export-cursor";
import { dayTypeOverrides, loadDayTypeOverrides, loadTargetProfiles, profileForDate }
  from "@/lib/server/export-targets";
import { fetchUpTo } from "@/lib/server/paged-read";
import type { ExportJson, ExportOpts } from "@/lib/server/export";
import type { DayType } from "@/lib/types";

export { dayTypeOverrides };

/** The `plan_days` rows for exactly these dates, so the query never scans the whole history. */
export const loadWaterOverrides = loadDayTypeOverrides;

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

/** The training weekdays and input weight of a revision, as the progress export (`targetFor`) and
 *  Today read them; an unparseable row has none, so the profile's own apply. */
function revisionInputs(profile: TargetProfile | null) {
  return profile ? targetsFromProfile(profile).revision?.inputs ?? null : null;
}

/**
 * Both day-type goals, plus the goal that applies to any date the caller asks about. With
 * `profiles` (oldest first), each date takes the weekdays and weight of its own revision; a date
 * with none (or no `profiles` at all) takes `revisionWeightKg` and the stored weekdays.
 */
export function waterGoalsFor(
  settings: WaterSettingsRow | null | undefined,
  overrides: ReadonlyMap<string, DayType>,
  revisionWeightKg?: number | string | null,
  profiles: readonly TargetProfile[] = [],
): ExportWaterGoals {
  const stored = settings ?? undefined;
  const prefs = waterPrefsOfDietPrefs(stored?.diet_prefs);
  const goal = (dayType: DayType, weight: number | string | null | undefined) =>
    resolveWaterGoal({ dayType, stored, prefs, weightKg: waterWeightKg(weight, stored?.weight_kg) })
      .cups;
  return {
    goal_training_cups: goal("training-10", revisionWeightKg),
    goal_rest_cups: goal("rest", revisionWeightKg),
    forDate: (localDate) => {
      const inputs = revisionInputs(profileForDate(profiles, localDate));
      const trainingWeekdays = inputs?.trainingWeekdays ?? stored?.training_weekdays;
      return goal(dayTypeFor(localDate, overrides.get(localDate), { trainingWeekdays }),
        inputs ? inputs.weightKg : revisionWeightKg);
    },
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

type WaterDay = { local_date: string; cups: number };

export async function streamWater(
  client: SupabaseClient, userId: string, opts: ExportOpts,
): Promise<ExportJson<WaterExportRow>> {
  const cursor = opts.cursor ? decodeDateCursor(opts.cursor) : undefined;
  const [all, settings] = await Promise.all([
    fetchUpTo<WaterDay>(opts.limit + 1, (after, size) => {
      let query = client.from("water_log").select("local_date, cups").eq("user_id", userId);
      if (opts.from) query = query.gte("local_date", opts.from);
      if (opts.to) query = query.lte("local_date", opts.to);
      const floor = after?.local_date ?? cursor;
      if (floor) query = query.gt("local_date", floor);
      return query.order("local_date", { ascending: true }).limit(size);
    }),
    client.from("user_settings")
      .select("water_goal_cups, water_goal_cups_training, water_goal_cups_rest, training_weekdays, "
        + "weight_kg, diet_prefs")
      .eq("user_id", userId).maybeSingle(),
  ]);
  if (settings.error) throw settings.error;

  const hasMore = all.length > opts.limit;
  const page = hasMore ? all.slice(0, opts.limit) : all;
  // T6: both goals travel, and `goal` is that date's goal after any per-date lock (T5) under that
  // date's own revision — the answer Today gives. The two per-day-type columns use the newest
  // revision the page reaches.
  const [overrides, profiles] = await Promise.all([
    loadDayTypeOverrides(client, userId, page.map((d) => d.local_date)),
    loadTargetProfiles(client, userId, page.at(-1)?.local_date),
  ]);
  const goals = waterGoalsFor(settings.data as WaterSettingsRow | null, overrides,
    revisionInputs(profiles.at(-1) ?? null)?.weightKg, profiles);
  const rows = page.map((d) => ({ local_date: d.local_date, cups: Number(d.cups),
    goal: goals.forDate(d.local_date), goal_training_cups: goals.goal_training_cups,
    goal_rest_cups: goals.goal_rest_cups }));
  const last = page.at(-1);
  return { rows, notices: [],
    next_cursor: hasMore && last ? encodeTextCursor(last.local_date) : null };
}
