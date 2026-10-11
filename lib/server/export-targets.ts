/**
 * W012: the per-date reads the progress and water exports share — the target revisions in force
 * on each exported date, and the day types the user locked (`plan_days.day_type_override`).
 *
 * Both used to be one plain select: `target_profiles` stopped at the API's 1,000-row cap and
 * dropped the NEWEST revisions (A071), and the override lookup sent a page's whole date list in one
 * `.in()` (A114). Both now page (lib/server/paged-read.ts) and fail whole, never partially. Every
 * read names the account's `user_id`, so the same code is safe under an admin client.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TargetProfile } from "@/lib/api-types";
import { fetchAllChunked, fetchAllRows } from "@/lib/server/paged-read";
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

/** The locked day types for exactly these dates, read in `.in()` chunks so no request is too long. */
export async function loadDayTypeOverrides(
  client: SupabaseClient, userId: string, dates: readonly string[],
): Promise<Map<string, DayType>> {
  if (dates.length === 0) return new Map();
  const rows = await fetchAllChunked<string, OverrideRow>([...new Set(dates)], (batch, from, to) =>
    client.from("plan_days").select("local_date, day_type_override").eq("user_id", userId)
      .in("local_date", batch).order("local_date", { ascending: true }).range(from, to));
  return dayTypeOverrides(rows);
}

/** Every revision effective on or before `through`, oldest first, read past the row cap. */
export async function loadTargetProfiles(
  client: SupabaseClient, userId: string, through: string | undefined,
): Promise<TargetProfile[]> {
  if (!through) return [];
  return fetchAllRows<TargetProfile>((from, to) => client.from("target_profiles").select("*")
    .eq("user_id", userId).lte("effective_from", through)
    .order("effective_from", { ascending: true }).order("rev", { ascending: true })
    .order("id", { ascending: true }).range(from, to));
}

/** The revision in force on `localDate` (latest `effective_from` ≤ date, then highest `rev`). */
export function profileForDate(profiles: readonly TargetProfile[], localDate: string): TargetProfile | null {
  let selected: TargetProfile | null = null;
  for (const profile of profiles) {
    if (profile.effective_from > localDate) break;
    selected = profile;
  }
  return selected;
}
