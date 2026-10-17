/**
 * The server's "today" for target revisions (t24b). Owner ruling: the phone's local day
 * everywhere. A revision is dated, and the revision in force is read, by this chain:
 *
 * 1. the phone's own day, when the request carries one (`clientDay`) and it is plausible: a
 *    travelling phone keeps its device day, so the server never dates a revision after the day
 *    the phone dated the same action by;
 * 2. the account's stored zone (`user_settings.time_zone`);
 * 3. the zone the request carries (`requestZone`), for an account with no stored zone;
 * 4. UTC, the last resort (`ACCOUNT_DAY_LAST_RESORT_ZONE`). It is logged every time it is used.
 *
 * No deployment-wide zone (`HEALTH_TZ`) is consulted: it would be one account's zone applied to
 * every other account, a personal default the tenancy rules forbid.
 *
 * Never `new Date().toISOString().slice(0, 10)`: on Vercel that is the UTC date, a day ahead of an
 * account in the Americas every evening and a day behind one in the Pacific every morning.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isIanaTimeZone } from "@/lib/health/contract";

/** The last resort, named so a reader can find every place it is used. */
export const ACCOUNT_DAY_LAST_RESORT_ZONE = "UTC";

export type AccountDaySource =
  | "client_day" | "account_zone" | "request_zone" | "utc_last_resort";

export type AccountDay = { date: string; zone: string | null; source: AccountDaySource };

export type AccountDayInput = {
  /** What the day is for, named in the last-resort log line. Never a user id or a payload. */
  purpose: string;
  storedZone?: string | null;
  requestZone?: string | null;
  /** The phone's own local day (YYYY-MM-DD), sent with the request. */
  clientDay?: unknown;
  now?: Date;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** The calendar date `now` falls on in `zone`. */
export function isoDateIn(zone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA",
    { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * The phone's day, when it is a real calendar date some zone on Earth can be on at `now`: every
 * zone (UTC−12 to UTC+14) is within one day of the UTC date. Anything else (a malformed value, a
 * phone clock days off) is not honoured, and the chain goes on to the zones.
 */
export function plausibleClientDay(day: unknown, now: Date = new Date()): string | null {
  if (typeof day !== "string" || !ISO_DAY.test(day)) return null;
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== day) return null;
  const utcDay = Date.parse(`${isoDateIn(ACCOUNT_DAY_LAST_RESORT_ZONE, now)}T00:00:00Z`);
  return Math.abs(at - utcDay) <= DAY_MS ? day : null;
}

/** The chain above, with the zone already read. Pure apart from the last-resort log line. */
export function resolveAccountDay(input: AccountDayInput): AccountDay {
  const now = input.now ?? new Date();
  const clientDay = plausibleClientDay(input.clientDay, now);
  if (clientDay) return { date: clientDay, zone: null, source: "client_day" };
  const steps: [unknown, AccountDaySource][] = [
    [input.storedZone, "account_zone"],
    [input.requestZone, "request_zone"],
  ];
  for (const [zone, source] of steps) {
    if (isIanaTimeZone(zone)) return { date: isoDateIn(zone, now), zone, source };
  }
  console.warn(`account-day: ${input.purpose} has no account or request zone; `
    + `dating by ${ACCOUNT_DAY_LAST_RESORT_ZONE} (last resort)`);
  return { date: isoDateIn(ACCOUNT_DAY_LAST_RESORT_ZONE, now),
    zone: ACCOUNT_DAY_LAST_RESORT_ZONE, source: "utc_last_resort" };
}

/** The account's stored zone. A failed read is logged and answers null, so the chain goes on to
 *  the request's zone: a zone read never fails the target read it serves. */
export async function readAccountZone(
  client: SupabaseClient, userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await client.from("user_settings").select("time_zone")
      .eq("user_id", userId).maybeSingle();
    if (error) throw error;
    const zone = (data as { time_zone?: unknown } | null)?.time_zone;
    return typeof zone === "string" && zone.trim() !== "" ? zone : null;
  } catch (e) {
    console.warn(`account-day: time zone read failed: ${e instanceof Error ? e.message : "unknown"}`);
    return null;
  }
}

/** The account's day: the phone's when plausible (no read), else from the stored zone onward. */
export async function accountDay(
  client: SupabaseClient, userId: string, input: Omit<AccountDayInput, "storedZone">,
): Promise<AccountDay> {
  if (plausibleClientDay(input.clientDay, input.now ?? new Date())) return resolveAccountDay(input);
  return resolveAccountDay({ ...input, storedZone: await readAccountZone(client, userId) });
}
