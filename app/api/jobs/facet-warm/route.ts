/**
 * GET|POST /api/jobs/facet-warm — Vercel cron, daily 04:20 UTC (a quiet hour; `vercel.json` also
 * fires 05:20, 06:20 and 07:20, which only resume an unfinished pass or retry its failures).
 *
 * Nothing warms foods on a user's Eats list: `food_facets` holds a tiny fraction of the
 * `human_food` rows plan-sheet suggestions and profile rules need (lib/coach/suggest-policy.ts),
 * so a packaged/prepared Eats food can never clear suggestion policy. This walks every settings
 * owner's own Eats list once a day and warms whatever is still missing, bounded per user
 * (`MAX_FOODS_PER_USER`), in flight (`CONCURRENCY` accounts at once) and overall (the shared
 * budget in lib/server/job-cursor.ts) so a long backlog cannot run past `maxDuration` or hammer the
 * shared Jev spend cap. Accounts are paged by key; when the budget runs out the pass for the UTC
 * date saves its progress and the next fire continues, then retries the accounts that failed. A
 * pass still unfinished is logged as a warning and answered with `incomplete: true`. A POST is an
 * explicit run and starts a fresh pass.
 *
 * Gate chain: timing-safe CRON_SECRET → enforceRateLimit (secret first, so an unauthenticated
 * caller cannot spend the cron's budget) → per-user `job_runs` lock, keyed by today's UTC date so
 * a retried run skips whoever already finished today; a run that warmed nothing and failed leaves
 * an "error" lock, which today's retry reclaims.
 */
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { accountIds, claimLock, cronSecretOk, releaseLock } from "@/lib/server/jobs";
import {
  BUDGET_MS, HARD_STOP_MS, listOf, markPass, sweep, utcDate,
} from "@/lib/server/job-cursor";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { warmEatsFacets } from "@/lib/server/eats-facet-warm";
import type { JobResponse } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const JOB_NAME = "facet-warm";
const MAX_FOODS_PER_USER = 40;
/** Few at once: every account's warm spends model calls against the shared Jev cap. */
const CONCURRENCY = 4;

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    // The secret first (Grok audit round 9): an unauthenticated caller must not spend the cron's
    // own hourly budget and 429 the real run.
    if (!cronSecretOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    await enforceRateLimit("jobs:facet-warm", 10, 3600);

    const admin = adminClient();
    const runKey = utcDate(new Date(startedAt));
    const out: JobResponse = { ran: 0, skipped: 0, errors: 0 };

    const warmOne = async (userId: string): Promise<"ok" | "skip" | "retry"> => {
      let hasLock = false;
      try {
        const lock = await claimLock(admin, JOB_NAME, userId, runKey);
        if (lock !== "taken") {
          out.skipped += 1;
          return lock === "done" ? "skip" : "retry";
        }
        hasLock = true;
        const result = await warmEatsFacets(admin, userId, { maxFoods: MAX_FOODS_PER_USER });
        // Nothing warmed and errors: an "error" lock is reclaimable, so today's retry can run.
        const failed = result.errors > 0 && result.warmed === 0;
        await releaseLock(admin, JOB_NAME, userId, runKey, failed ? "error" : "ok", result);
        if (failed) out.errors += 1; else out.ran += 1;
        return failed ? "retry" : "ok";
      } catch (e) {
        if (hasLock) {
          await releaseLock(admin, JOB_NAME, userId, runKey, "error",
            { message: e instanceof Error ? e.message : "unknown" });
        }
        console.error("facet warm job failed for user", { userId, error: e });
        out.errors += 1;
        return "retry";
      }
    };

    const pass = await sweep(admin, {
      job: JOB_NAME, period: runKey, restart: req.method === "POST",
      list: (after) => accountIds(admin, after), byKeys: listOf, keyOf: (userId) => userId,
      concurrency: CONCURRENCY, deadline: startedAt + BUDGET_MS,
      hardStop: startedAt + HARD_STOP_MS, work: warmOne,
      onError: (userId, error) => {
        out.errors += 1;
        console.error("facet warm job failed for user", { userId, error });
      },
    });
    markPass(out, pass);
    return Response.json(out);
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = POST;
