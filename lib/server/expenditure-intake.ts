/**
 * The expenditure engine's intake read (lib/server/expenditure.ts `runEstimate`).
 *
 * A day's logged energy is `daily_energy` (lib/server/day-energy.ts). Ticking a planned meal eaten
 * or eating an accepted recipe writes `plan_days.eaten_slots` (and the frozen override or the
 * consumed snapshot), not a log entry, yet the phone's ring counts it (lib/resolve.ts). A day that
 * holds such a meal therefore ate more than `daily_energy` says, and counting it at the logged part
 * alone would read the account's TDEE too low (audit 2026-10-10 A155).
 *
 * The rule here mirrors lib/plan/eaten-estimate.ts: a log filed under an eaten slot is that slot's
 * record, so the day is complete as logged. An eaten slot with no live log under it holds food the
 * server cannot count, so the whole day is intake-unknown: it never qualifies, marked or not.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readByDateChunks, readByIdBatches } from "@/lib/server/date-chunks";
import { readDailyEnergy } from "@/lib/server/day-energy";
import type { IntakeDay } from "@/lib/expenditure";

type Row = Record<string, unknown>;

export type PlanDayState = {
  /** `day_complete_at` is set (step E6). */
  marked: Set<string>;
  /** Per date, the slot ids ticked eaten (a non-null `eaten_at`); ticked recipes included. */
  eatenSlots: Map<string, Set<string>>;
};

/** Slot ids whose mark carries a non-null `eaten_at`. A null `eaten_at` is an untick tombstone. */
export function eatenSlotIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([id, mark]) => {
    const eatenAt = mark && typeof mark === "object" ? (mark as Row).eaten_at : null;
    return typeof eatenAt === "string" && eatenAt.length > 0 ? [id] : [];
  });
}

export async function planDayState(
  admin: SupabaseClient, userId: string, from: string, to: string,
): Promise<PlanDayState> {
  const rows = await readByDateChunks(from, to, async (start, end) => {
    const { data, error } = await admin.from("plan_days")
      .select("local_date, day_complete_at, eaten_slots")
      .eq("user_id", userId).gte("local_date", start).lte("local_date", end);
    if (error) throw error;
    return (data ?? []) as Row[];
  });
  const marked = new Set<string>();
  const eatenSlots = new Map<string, Set<string>>();
  for (const row of rows) {
    const date = String(row.local_date).slice(0, 10);
    if (row.day_complete_at !== null && row.day_complete_at !== undefined) marked.add(date);
    const ids = eatenSlotIds(row.eaten_slots);
    if (ids.length > 0) eatenSlots.set(date, new Set(ids));
  }
  return { marked, eatenSlots };
}

/** Per date, the slots a live log entry is filed under. Only the given dates are read. */
async function loggedSlots(
  admin: SupabaseClient, userId: string, dates: string[],
): Promise<Map<string, Set<string>>> {
  const rows = await readByIdBatches(dates, async (batch) => {
    const { data, error } = await admin.from("log_entries").select("local_date, slot")
      .eq("user_id", userId).in("local_date", batch).is("deleted_at", null);
    if (error) throw error;
    return (data ?? []) as Row[];
  });
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const date = String(row.local_date).slice(0, 10);
    const set = out.get(date) ?? new Set<string>();
    set.add(String(row.slot));
    out.set(date, set);
  }
  return out;
}

/** Dates holding an eaten slot that no live log entry records: their intake is unknown. */
export async function unloggedEatenDates(
  admin: SupabaseClient, userId: string, eatenSlots: Map<string, Set<string>>,
): Promise<Set<string>> {
  const dates = [...eatenSlots.keys()].sort();
  if (dates.length === 0) return new Set();
  const logged = await loggedSlots(admin, userId, dates);
  return new Set(dates.filter((date) => {
    const filed = logged.get(date);
    return [...eatenSlots.get(date)!].some((slot) => !filed?.has(slot));
  }));
}

export async function intakeDays(
  admin: SupabaseClient, userId: string, from: string, to: string,
): Promise<IntakeDay[]> {
  // `daily_energy` applies the one energy rule per item before it sums the day: 100 reported +
  // 80 calculated kcal is 180, not the 100 the reported-only `daily_totals` row holds.
  const [days, plan] = await Promise.all([
    readDailyEnergy(admin, userId, from, to),
    planDayState(admin, userId, from, to),
  ]);
  const unknown = await unloggedEatenDates(admin, userId, plan.eatenSlots);
  // No item with usable energy, or an eaten meal the log does not hold: the intake is unknown,
  // not the logged part. A marked day would otherwise qualify (R3) and enter the engine short.
  return [...days.values()].flatMap((day) => day.kcal === null || unknown.has(day.localDate) ? [] : [{
    date: day.localDate,
    kcal: day.kcal,
    energyCoverage: day.coverage,
    userMarkedComplete: plan.marked.has(day.localDate),
  }]);
}
