import type { SupabaseClient } from "@supabase/supabase-js";
import { localDateIn } from "@/lib/server/jobs";

type AccountClock = { now: string; tz: string; date: string };

export type LogEntryExistsPort = (
  client: SupabaseClient, userId: string, date: string, signal?: AbortSignal,
) => Promise<boolean>;

/** One owner-scoped existence read; the account's local_date was stored with the entry. */
export const liveLogEntryExists: LogEntryExistsPort = async (client, userId, date, signal) => {
  const query = client.from("log_entries").select("id")
    .eq("user_id", userId).eq("local_date", date).is("deleted_at", null).limit(1);
  const bounded = signal && typeof query.abortSignal === "function"
    ? query.abortSignal(signal) : query;
  const { data, error } = await bounded;
  if (error) throw error;
  return (data?.length ?? 0) > 0;
};

/** Scoped dates may be in the past; a future day must never prompt a log. */
export async function hasUnloggedMeal(
  client: SupabaseClient, userId: string, clock: AccountClock,
  entryExists: LogEntryExistsPort = liveLogEntryExists,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (clock.date > localDateIn(clock.tz, new Date(clock.now))) return false;
    if (signal?.aborted) return false;
    return !(await entryExists(client, userId, clock.date, signal));
  } catch {
    if (!signal?.aborted) console.warn("coach log entry read failed", { userId });
    return false;
  }
}
