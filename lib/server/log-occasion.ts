/**
 * Stamp `log_entries.occasion` after a log is applied (Phase 17 O2, D1; migration
 * 20261210090200_log_entries_occasion).
 *
 * Every log entry reaches the database through `apply_sync_op` (commit, the phone's outbox, a coach
 * move), and none of them sends an occasion, so an old client keeps
 * working. This runs after the write, on the caller's own RLS client with an explicit `user_id`
 * filter, and computes the occasion from the slot's clock on that local date
 * (`lib/meals/schedule.ts`). The update is guarded on the slot and date it was computed from, so
 * a move that lands in between is never stamped with the old slot's occasion; the move clears the
 * stamp itself (the migration's trigger) and its own op restamps it. Only unstamped entries are
 * stamped, and the write requires the row to be unstamped still, so an existing stamp (an older
 * log in the same slot, a user's choice, even one set after the read) is never overwritten. Only
 * rows actually written are counted.
 *
 * A recipe eaten through `recipe_log_consumed` writes no log entry (it records a consumed
 * snapshot on plan_days), so it has nothing to stamp and is not history. An entry written before
 * the migration stays null unless the user writes it again (that write's id is in scope).
 *
 * The slot clock is the schedule's (`resolveSlotTimes`), which does not depend on the day type;
 * no account stores per-slot occasion overrides yet, so `override` is never written today.
 *
 * Best-effort by contract: callers log a failure and never fail the log over it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { entryOccasion, type MealSchedule } from "@/lib/meals/schedule";
import { activeProfile } from "@/lib/server/targets";

type EntryRow = {
  id: string; slot: string; local_date: string; eaten_at: string | null; tz: string | null;
  occasion: string | null; occasion_source: string | null; deleted_at: string | null;
};

/** Only the entries the caller just wrote, by id: never a slot or a date (Sol r4 BLOCK 2). */
export type OccasionScope = { ids: readonly string[] };

const ID_BATCH = 100;

async function readEntries(client: SupabaseClient, userId: string, scope: OccasionScope): Promise<EntryRow[]> {
  const columns = "id,slot,local_date,eaten_at,tz,occasion,occasion_source,deleted_at";
  const ids = [...new Set(scope.ids.map((id) => id.toLowerCase()))];
  const rows: EntryRow[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const { data, error } = await client.from("log_entries").select(columns)
      .eq("user_id", userId).in("id", ids.slice(i, i + ID_BATCH));
    if (error) throw error;
    rows.push(...((data ?? []) as EntryRow[]));
  }
  return rows;
}

type ScheduleSettings = Omit<MealSchedule, "trainingKcal">;

async function readScheduleSettings(client: SupabaseClient, userId: string): Promise<ScheduleSettings> {
  const { data, error } = await client.from("user_settings")
    .select("slot_times,shift_minutes,meals_per_day").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const row = (data ?? {}) as { slot_times?: unknown; shift_minutes?: unknown; meals_per_day?: unknown };
  const slotTimes = row.slot_times && typeof row.slot_times === "object"
    ? Object.fromEntries(Object.entries(row.slot_times as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  const mealsPerDay = typeof row.meals_per_day === "number" && Number.isInteger(row.meals_per_day)
    && row.meals_per_day >= 2 && row.meals_per_day <= 6 ? row.meals_per_day : null;
  return {
    slotTimes,
    shiftMinutes: typeof row.shift_minutes === "number" && Number.isFinite(row.shift_minutes)
      ? row.shift_minutes : 0,
    mealsPerDay,
  };
}

/**
 * Training calories of the target revision in force on `date` (the server's date-effective read,
 * `activeProfile(…, effectiveOn)`): a past entry's meal count is the one its own day had, never
 * today's (Sol r4 BLOCK 1).
 */
async function trainingKcalOn(client: SupabaseClient, userId: string, date: string | undefined): Promise<number | null> {
  const revision = await activeProfile(client, userId, ...(date ? [date] : []));
  const kcal = (revision as { training_macros?: { kcal?: unknown } } | null)?.training_macros?.kcal;
  return typeof kcal === "number" && Number.isFinite(kcal) ? kcal : null;
}

/** The account's schedule on `date` (default: today), as Today reads it for that day. */
export async function readMealSchedule(client: SupabaseClient, userId: string, date?: string): Promise<MealSchedule> {
  const settings = await readScheduleSettings(client, userId);
  return { ...settings,
    trainingKcal: settings.mealsPerDay === null ? await trainingKcalOn(client, userId, date) : null };
}

/** Per-day slot time edits for the dates the entries name. */
async function dayTimes(client: SupabaseClient, userId: string, dates: readonly string[]):
  Promise<Map<string, Record<string, unknown>>> {
  if (!dates.length) return new Map();
  const { data, error } = await client.from("plan_days").select("local_date,item_overrides")
    .eq("user_id", userId).in("local_date", [...new Set(dates)]);
  if (error) throw error;
  return new Map(((data ?? []) as { local_date: string; item_overrides: unknown }[])
    .map((row) => [row.local_date, (row.item_overrides ?? {}) as Record<string, unknown>]));
}

function timeOf(overrides: Record<string, unknown> | undefined, slot: string): string | null {
  const row = overrides?.[slot];
  const time = row && typeof row === "object" ? (row as { time?: unknown }).time : undefined;
  return typeof time === "string" ? time : null;
}

/** Stamp the entries in scope; returns how many rows were written. */
export async function stampLogOccasions(
  client: SupabaseClient, userId: string, scope: OccasionScope,
): Promise<number> {
  // Only an entry with no stamp is stamped: one just written, or one a move just cleared (the
  // migration's trigger). A stamp already written records the occasion AT LOG TIME and is never
  // recomputed later (a schedule change, a sibling log in the same slot, a non-moving edit).
  const entries = (await readEntries(client, userId, scope))
    .filter((row) => row.deleted_at === null && row.occasion_source === null && row.occasion === null);
  if (!entries.length) return 0;
  const dates = [...new Set(entries.map((row) => row.local_date))].sort();
  const [settings, times] = await Promise.all([
    readScheduleSettings(client, userId), dayTimes(client, userId, dates),
  ]);
  // The meal count comes from each entry's own day's target revision when the account chose none.
  const schedules = new Map<string, MealSchedule>();
  for (const date of dates) {
    schedules.set(date, { ...settings,
      trainingKcal: settings.mealsPerDay === null ? await trainingKcalOn(client, userId, date) : null });
  }
  let written = 0;
  for (const entry of entries) {
    const next = entryOccasion({ slot: entry.slot, dayTime: timeOf(times.get(entry.local_date), entry.slot),
      eatenAt: entry.eaten_at, tz: entry.tz }, schedules.get(entry.local_date) as MealSchedule);
    // Guarded on everything it was computed from AND on the stamp it replaces: a move, a delete or
    // a user's own choice that lands between the read and this write makes it a no-op.
    const update = client.from("log_entries")
      .update({ occasion: next.occasion, occasion_source: next.source })
      .eq("user_id", userId).eq("id", entry.id)
      .eq("slot", entry.slot).eq("local_date", entry.local_date).is("deleted_at", null);
    // The eating time and zone decide the occasion of an unscheduled slot ("snack"): an edit to
    // either between the read and this write makes it a no-op too.
    const timed = (entry.eaten_at === null ? update.is("eaten_at", null) : update.eq("eaten_at", entry.eaten_at));
    const zoned = entry.tz === null ? timed.is("tz", null) : timed.eq("tz", entry.tz);
    const { data, error } = await zoned.is("occasion_source", null).is("occasion", null).select("id");
    if (error) throw error;
    written += (data ?? []).length;
  }
  return written;
}

/** The caller's wrapper: stamp, and log (never throw) on failure. */
export async function stampLogOccasionsSafely(
  client: SupabaseClient, userId: string, scope: OccasionScope,
): Promise<void> {
  try {
    await stampLogOccasions(client, userId, scope);
  } catch (error) {
    console.error("log occasion stamp failed", { error: error instanceof Error ? error.message : "unknown" });
  }
}
