import { timingSafeEqual } from "node:crypto";
import { healthTimeZone } from "@/lib/health/contract";
import type { adminClient } from "@/lib/server/admin";
import { keysetRows } from "@/lib/server/job-sweep";

export const DEFAULT_TZ = "UTC";

export function localDateIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit",
    day: "2-digit" }).format(now);
}

/** The Monday that starts the week a date belongs to; a Sunday belongs to the week just ending. */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = Date.UTC(y, m - 1, d);
  const dow = new Date(at).getUTCDay();               // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  return new Date(at - back * 86_400_000).toISOString().slice(0, 10);
}

export function cronSecretOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Every settings owner, in `user_id` order, paged by key past the API's 1,000-row cap and
 *  starting after `after` (a resume cursor; null for the start). `user_settings.user_id` is the
 *  primary key, so each account appears once. */
export function accountIds(
  admin: ReturnType<typeof adminClient>, after: string | null = null,
): AsyncGenerator<string> {
  return mapRows(keysetRows<{ user_id: string }>((last, size) => {
    let query = admin.from("user_settings").select("user_id").not("user_id", "is", null);
    if (last !== null) query = query.gt("user_id", last);
    return query.order("user_id", { ascending: true }).range(0, size - 1);
  }, (row) => row.user_id, after), (row) => row.user_id);
}

async function* mapRows<T, U>(rows: AsyncIterable<T>, map: (row: T) => U): AsyncGenerator<U> {
  for await (const row of rows) yield map(row);
}

/** A "running" row older than this could not still be a live function instance (none of these
 *  jobs run anywhere near this long) — it is a crash/kill orphan, not a live lock. */
const STALE_LOCK_MS = 15 * 60 * 1000;

/** Returns false when another run is actually still in progress for this (job, user, key). A
 *  pre-existing row that is *not* still in progress — a finished "error" run, or a "running" row
 *  abandoned by a killed instance — is reclaimed instead of blocking every retry for the rest of
 *  the period. The reclaim is a single conditional UPDATE, so a genuinely live "running" row
 *  (recent, no matching WHERE) is left untouched. */
export async function takeLock(
  admin: ReturnType<typeof adminClient>, job: string, userId: string, runKey: string,
): Promise<boolean> {
  const { error } = await admin.from("job_runs")
    .insert({ job, user_id: userId, run_key: runKey, status: "running" }).select("job");
  if (!error) return true;
  if ((error as { code?: string }).code !== "23505") throw error;

  const staleBefore = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const { data, error: reclaimError } = await admin.from("job_runs")
    .update({ status: "running", started_at: new Date().toISOString(), finished_at: null, detail: null })
    .eq("job", job).eq("user_id", userId).eq("run_key", runKey)
    .or(`status.eq.error,and(status.eq.running,started_at.lt."${staleBefore}")`)
    .select("job");
  if (reclaimError) throw reclaimError;
  return (data?.length ?? 0) > 0;
}

/** What a lock attempt found: `taken` (this run holds it now), `done` (finished "ok", final),
 *  `busy` (a live "running" row: another run may still fail, so it is not final), or `failed` (an
 *  "error" row this caller chose not to reclaim). */
export type LockClaim = "taken" | "done" | "busy" | "failed";

/** `takeLock` that says why it did not take the lock. With `reclaimErrors: false` an "error" row
 *  is reported as `failed` instead of reclaimed. With `reclaimStale: false` a stale "running" row
 *  (an abandoned or unrecorded attempt) is also reported as `failed`, never taken again: a capped
 *  job counts it as a spent attempt. */
export async function claimLock(
  admin: ReturnType<typeof adminClient>, job: string, userId: string, runKey: string,
  opts: { reclaimErrors?: boolean; reclaimStale?: boolean } = {},
): Promise<LockClaim> {
  const reclaimErrors = opts.reclaimErrors ?? true;
  const reclaimStale = opts.reclaimStale ?? true;
  const { error } = await admin.from("job_runs")
    .insert({ job, user_id: userId, run_key: runKey, status: "running" }).select("job");
  if (!error) return "taken";
  if ((error as { code?: string }).code !== "23505") throw error;

  const staleBefore = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const stale = `and(status.eq.running,started_at.lt."${staleBefore}")`;
  const reclaimable = [reclaimErrors ? "status.eq.error" : null, reclaimStale ? stale : null]
    .filter((c): c is string => c !== null);
  if (reclaimable.length > 0) {
    const { data, error: reclaimError } = await admin.from("job_runs")
      .update({ status: "running", started_at: new Date().toISOString(), finished_at: null,
        detail: null })
      .eq("job", job).eq("user_id", userId).eq("run_key", runKey)
      .or(reclaimable.join(","))
      .select("job");
    if (reclaimError) throw reclaimError;
    if ((data?.length ?? 0) > 0) return "taken";
  }

  const { data: held, error: readError } = await admin.from("job_runs")
    .select("status, started_at").match({ job, user_id: userId, run_key: runKey });
  if (readError) throw readError;
  const row = ((held ?? []) as { status?: string; started_at?: string }[])[0];
  if (row?.status === "ok") return "done";
  if (row?.status === "error") return "failed";
  if (row?.status === "running" && row.started_at !== undefined
    && Date.parse(row.started_at) < Date.parse(staleBefore)) return "failed";
  return "busy";
}

/** Records how a run ended. A failed write is retried once and then thrown, loudly: a lock left
 *  "running" would later read as abandoned and be reclaimed, which for a capped job (the weekly
 *  review) must not happen silently. */
export async function releaseLock(
  admin: ReturnType<typeof adminClient>, job: string, userId: string, runKey: string,
  status: "ok" | "error", detail?: unknown,
): Promise<void> {
  const write = async () => {
    const result = await admin.from("job_runs")
      .update({ status, finished_at: new Date().toISOString(), detail: detail ?? null })
      .eq("job", job).eq("user_id", userId).eq("run_key", runKey);
    return (result as { error?: { message?: string } | null } | undefined)?.error ?? null;
  };
  if (!(await write())) return;
  const second = await write();
  if (!second) return;
  console.error("JOB LOCK RELEASE FAILED twice; the row stays 'running'", { job, userId, runKey,
    status, error: second.message ?? "unknown" });
  throw new Error(`could not record ${job} ${status} for ${runKey}`);
}

/** The Monday that starts the user's local week just ending — the same
 *  week_start Lane Q's proposal job computes, via the same local-date + mondayOf pair. Raw UTC
 *  day arithmetic here reads a week 7 days ahead for several hours around each Sunday/Monday
 *  boundary, since the cron can fire while it is still Sunday night for the user. */
export function weekStartOf(
  now: Date = new Date(), userTimeZone?: string | null,
): string {
  return mondayOf(localDateIn(
    healthTimeZone(null, userTimeZone, process.env.HEALTH_TZ ?? DEFAULT_TZ), now,
  ));
}

/** The week a weekly job reviews for an account: the Monday of the week containing the account's
 *  local date at `instant`, less one day. On a local Sunday that is the week ending today; on a
 *  local Monday (UTC and east of it when the Monday-UTC cron fires) it is the week that just
 *  ended, never the one starting. */
export function weekJustEnding(timeZone: string, instant: Date): string {
  const [y, m, d] = localDateIn(timeZone, instant).split("-").map(Number);
  return mondayOf(new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10));
}

/** The user's local calendar date — never the server process's own, which on Vercel is UTC and
 *  can already read tomorrow while it is still tonight for the user. */
export function todayIso(now: Date = new Date(), userTimeZone?: string | null): string {
  return localDateIn(healthTimeZone(null, userTimeZone, process.env.HEALTH_TZ ?? DEFAULT_TZ), now);
}

/** Every settings owner with the zone their local-time jobs run in: the saved IANA zone, else
 *  HEALTH_TZ, else UTC — the same resolution `timeZoneFor` and `weekStartOf` use. Paged by key in
 *  `user_id` order, so an hourly job does not cost a query per account. */
export function accountZones(
  admin: ReturnType<typeof adminClient>, after: string | null = null,
): AsyncGenerator<{ userId: string; timeZone: string }> {
  type Row = { user_id: string; time_zone?: string | null };
  return mapRows(keysetRows<Row>((last, size) => {
    let query = admin.from("user_settings").select("user_id, time_zone")
      .not("user_id", "is", null);
    if (last !== null) query = query.gt("user_id", last);
    return query.order("user_id", { ascending: true }).range(0, size - 1);
  }, (row) => row.user_id, after), (row) => ({
    userId: row.user_id,
    timeZone: healthTimeZone(null, row.time_zone ?? null, process.env.HEALTH_TZ ?? DEFAULT_TZ),
  }));
}

/** The weekly review lands on the account's own Sunday evening (AI-integration audit P2 #15). */
export const WEEKLY_REVIEW_LOCAL_HOUR = 18;

/** The account's local hour when it is Sunday there, else null. */
function localSundayHour(now: Date, timeZone: string): number | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return weekday === "Sun" ? hour : null;
}

/** True during the account's local Sunday 18:00–18:59, the hour its review is meant to land. The
 *  window is one local hour, so an hourly cron meets it exactly once a week in every zone —
 *  whole-hour, half-hour (India) and quarter-hour (Nepal) offsets alike. A DST change moves the UTC
 *  hour the window falls in, never the local one, so the week of a change neither skips nor
 *  doubles the review. */
export function inWeeklyReviewWindow(now: Date, timeZone: string): boolean {
  return localSundayHour(now, timeZone) === WEEKLY_REVIEW_LOCAL_HOUR;
}

/** True from the account's local Sunday 18:00 to the end of its Sunday: the review hour plus the
 *  catch-up hours. One hourly run cannot review every account of a crowded zone within its time
 *  budget, so the accounts it did not reach are picked up by the next fires the same evening; the
 *  per-week `job_runs` lock keeps each account to one review. It stops before the local Monday,
 *  when `weekStartOf` would already name the week now starting. */
export function weeklyReviewDue(now: Date, timeZone: string): boolean {
  const hour = localSundayHour(now, timeZone);
  return hour !== null && hour >= WEEKLY_REVIEW_LOCAL_HOUR;
}
