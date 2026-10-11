/**
 * GET|POST /api/jobs/weekly-review — Vercel cron, hourly. Each run reviews the accounts whose own
 * local time is Sunday 18:00 or later that Sunday (user_settings.time_zone, else HEALTH_TZ, else
 * UTC), for the local week just ending (AI-integration audit P2 #15: one UTC fire time was Sunday
 * evening only in US Eastern).
 * Order: timing-safe CRON_SECRET, enforceRateLimit (scale S2: the shared limit must not be spendable
 * without the secret), flag, job_runs lock.
 * The lock key is ('weekly-review-local', user_id, week_start) — one run per user-week. The name
 * differs from the old UTC job's 'weekly-review' because that job, firing Monday 01:30 UTC, already
 * holds 'ok' locks keyed by the week now starting for every account east of UTC; reusing it would
 * skip their first local review. writeWeeklyReview's (user_id, review_week) guard still refuses a
 * second review of one week.
 *
 * Scale (S3): accounts are paged by key and reviewed `CONCURRENCY` at a time; no new review starts
 * after `TIME_BUDGET_MS`. A crowded zone can hold more accounts than one run reaches, so an account
 * stays due through the rest of its Sunday (`weeklyReviewDue`): the next hourly fires pick up
 * whoever the last one did not reach, and the week lock skips whoever it did. Those catch-up skips
 * are not counted; a held lock counts as skipped only in the account's own 18:00 hour.
 *
 * A failed review is retried once, never more, so a review whose save fails after the model call
 * cannot pay for a new generation every hour: the week lock is not reclaimed on error; a second lock
 * (`<week>#retry`) allows exactly one more attempt, in a later run.
 */

import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { writeWeeklyReview } from "@/lib/server/coach";
import {
  accountZones, claimLock, cronSecretOk, inWeeklyReviewWindow, releaseLock, weeklyReviewDue,
  weekStartOf,
} from "@/lib/server/jobs";
import { runWithinBudget } from "@/lib/server/job-sweep";
import { BUDGET_MS, HARD_STOP_MS } from "@/lib/server/job-cursor";
import type { JobResponse } from "@/lib/api-types";
import { coachEnabled } from "@/lib/capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const JOB_NAME = "weekly-review-local";
/** Few at once: every review is a model call. */
const CONCURRENCY = 4;

/** The week's lock, or its one retry when the first attempt failed; null when there is nothing to
 *  attempt (done, held by a live run, or the retry is spent). Neither key is ever reclaimed: an
 *  attempt that failed, or that left a stale "running" row (killed, or its status could not be
 *  recorded), counts as spent, so a week costs at most two model calls. */
async function weekLock(
  admin: ReturnType<typeof adminClient>, userId: string, weekStart: string,
): Promise<{ key: string } | { held: "done" | "busy" | "spent" }> {
  const once = { reclaimErrors: false, reclaimStale: false };
  const first = await claimLock(admin, JOB_NAME, userId, weekStart, once);
  if (first === "taken") return { key: weekStart };
  if (first !== "failed") return { held: first };
  const retryKey = `${weekStart}#retry`;
  const retry = await claimLock(admin, JOB_NAME, userId, retryKey, once);
  if (retry === "taken") return { key: retryKey };
  return { held: retry === "failed" ? "spent" : retry };
}

type Due = { userId: string; timeZone: string };

async function* dueAccounts(
  admin: ReturnType<typeof adminClient>, now: Date,
): AsyncGenerator<Due> {
  for await (const account of accountZones(admin)) {
    // Before the account's own Sunday 18:00, or already its Monday: not due, not counted.
    if (weeklyReviewDue(now, account.timeZone)) yield account;
  }
}

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (!cronSecretOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    await enforceRateLimit("jobs:weekly-review", 10, 3600);
    if (!coachEnabled()) return Response.json({ ok: true, skipped: "coach_disabled" });

    const admin = adminClient();
    const out: JobResponse = { ran: 0, skipped: 0, errors: 0 };
    const now = new Date();

    const reviewOne = async ({ userId, timeZone }: Due): Promise<void> => {
      const weekStart = weekStartOf(now, timeZone);
      let lockKey: string | null = null;
      try {
        const lock = await weekLock(admin, userId, weekStart);
        if (!("key" in lock)) {
          if (inWeeklyReviewWindow(now, timeZone)) out.skipped += 1;
          return;
        }
        lockKey = lock.key;
        const result = await writeWeeklyReview(admin, userId, weekStart);
        await releaseLock(admin, JOB_NAME, userId, lockKey, "ok", result);
        // A duplicate, or a week with no logged day (no message, no model call: W035).
        if (result.duplicate || "skipped" in result) out.skipped += 1;
        else out.ran += 1;
      } catch (e) {
        if (lockKey) {
          // A failed write is logged loudly by releaseLock; the row then reads as spent.
          await releaseLock(admin, JOB_NAME, userId, lockKey, "error",
            { message: e instanceof Error ? e.message : "unknown" }).catch(() => undefined);
        }
        console.error("weekly review job failed for user", { userId, error: e });
        out.errors += 1;
      }
    };

    const pass = await runWithinBudget({
      items: dueAccounts(admin, now), keyOf: (account) => account.userId,
      concurrency: CONCURRENCY, deadline: startedAt + BUDGET_MS,
      hardStop: startedAt + HARD_STOP_MS, work: reviewOne,
      onError: (account, error) => {
        out.errors += 1;
        console.error("weekly review job failed for user", { userId: account.userId, error });
      },
    });
    if (pass.listError !== undefined) throw pass.listError;
    if (!pass.complete) {
      out.incomplete = true;
      console.warn("weekly review stopped at its budget; the next hourly fire continues",
        { started: pass.started });
    }
    return Response.json(out);
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = POST;
