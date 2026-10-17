/**
 * GET|POST /api/jobs/estimate — Vercel cron, nightly 03:00 user tz (`vercel.json`: `0 7-9 * * *` UTC;
 * the later fires only resume an unfinished pass).
 *
 * Gate chain (scale S2 order: secret first, so the shared limit can't be spent unauthenticated): timing-safe CRON_SECRET → rate limit →
 * ESTIMATOR_ENABLED → per-user `job_runs` lock. The user ids come from a query this handler
 * scopes, never from a request body (§2.2). Harmless with the UI off: it writes only
 * `expenditure_estimates`.
 *
 * Weigh-ins arrive through the injected `WeighInsPort` — Lane P's `weighInsKg` in
 * `lib/server/health-daily.ts`, the one read path for merged body data (contracts §2).
 *
 * Scale (S3): accounts are paged by key and run `CONCURRENCY` at a time within the shared budget
 * (lib/server/job-cursor.ts). The pass for the UTC date resumes on the next fire (`vercel.json`
 * fires 07:00, 08:00 and 09:00 UTC), then retries exactly the accounts that failed or were held;
 * a pass with nothing left makes the later fires no-ops. Each account's day is taken at the pass's
 * start, so every fire computes the same day. A POST is an explicit run and starts a fresh pass;
 * the per-user lock still skips whoever already has that day's estimate.
 */
import { accountIds, claimLock, cronSecretOk, releaseLock } from "@/lib/server/jobs";
import {
  BUDGET_MS, HARD_STOP_MS, listOf, markPass, sweep, utcDate,
} from "@/lib/server/job-cursor";
import {
  ACCOUNT_DAY_LAST_RESORT_ZONE, readAccountZoneStrict, resolveAccountDay,
} from "@/lib/server/account-day";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { runEstimate } from "@/lib/server/expenditure";
import { mergedDays, weighInsKg } from "@/lib/server/health-daily";
import type { JobResponse } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const JOB_NAME = "estimate";
const CONCURRENCY = 6;

export async function POST(req: Request): Promise<Response> {
  try {
    if (!cronSecretOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    await enforceRateLimit("jobs:estimate", 10, 3600);
    if (!process.env.ESTIMATOR_ENABLED) {
      throw new HttpError(503, "unavailable", "ESTIMATOR_ENABLED is off");
    }
    const startedAt = Date.now();
    const admin = adminClient();
    const out: JobResponse = { ran: 0, skipped: 0, errors: 0 };

    const estimateOne = async (
      userId: string, { passStartedAt }: { passStartedAt: Date },
    ): Promise<"ok" | "skip" | "retry"> => {
      let asOf: string | null = null;
      let hasLock = false;
      try {
        // The account's own day (t24b): its stored zone, else UTC as the logged last resort, never
        // the deployment-wide HEALTH_TZ. The seed's target lookup (runEstimate → seedFor) and the
        // activity summary use the same day and zone.
        const day = resolveAccountDay({ purpose: "estimate job", now: passStartedAt,
          storedZone: await readAccountZoneStrict(admin, userId) });
        asOf = day.date;
        const lock = await claimLock(admin, JOB_NAME, userId, asOf);
        if (lock !== "taken") {
          out.skipped += 1;
          return lock === "done" ? "skip" : "retry";
        }
        hasLock = true;
        const result = await runEstimate(admin, userId, asOf, {
          weighIns: weighInsKg,
          activityDays: mergedDays,
          timeZone: day.zone ?? ACCOUNT_DAY_LAST_RESORT_ZONE,
        });
        await releaseLock(admin, JOB_NAME, userId, asOf, "ok", { status: result.status });
        out.ran += 1;
        return "ok";
      } catch (e) {
        if (hasLock && asOf) {
          await releaseLock(admin, JOB_NAME, userId, asOf, "error",
            { message: e instanceof Error ? e.message : "unknown" });
        }
        console.error("estimate job failed for user", { userId, error: e });
        out.errors += 1;
        return "retry";
      }
    };

    const pass = await sweep(admin, {
      job: JOB_NAME, period: utcDate(new Date(startedAt)), restart: req.method === "POST",
      list: (after) => accountIds(admin, after), byKeys: listOf, keyOf: (userId) => userId,
      concurrency: CONCURRENCY, deadline: startedAt + BUDGET_MS,
      hardStop: startedAt + HARD_STOP_MS, work: estimateOne,
      onError: (userId, error) => {
        out.errors += 1;
        console.error("estimate job failed for user", { userId, error });
      },
    });
    markPass(out, pass);
    return Response.json(out);
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = POST;
