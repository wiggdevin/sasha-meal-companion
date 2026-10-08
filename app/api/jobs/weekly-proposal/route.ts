/**
 * GET|POST /api/jobs/weekly-proposal — Vercel cron, Sunday 21:00 user tz (`vercel.json`:
 * `0 1-3 * * 1` UTC; the later fires only resume an unfinished pass). Idempotent on `(user_id, week_start)` through both the `job_runs` lock and
 * the unique index; a second Sunday auto-rejects the older pending row rather than stacking a
 * second card (spec open question 6, ASSUMED).
 *
 * Only `status = 'estimating'` produces a proposal. A `blocked` outcome writes a blocked ESTIMATE
 * and no proposal — the engine refuses, and approval remains a user decision.
 *
 * Weigh-ins arrive through the injected `WeighInsPort` — Lane P's `weighInsKg` in
 * `lib/server/health-daily.ts`, the one read path for merged body data (contracts §2).
 *
 * Scale (S3): accounts are paged by key and run `CONCURRENCY` at a time within the shared budget
 * (lib/server/job-cursor.ts); the pass (per UTC date, or per requested week) resumes on the next
 * fire and then retries the accounts that failed or were held. Every date and week here is taken
 * at the pass's start instant, never at the fire's own time: at 01:00 UTC Monday it is still
 * Sunday in America/Noronha and at 02:00 it is Monday, so a resumed fire computing "now" would
 * hand later accounts the next week. The week is the one just ending in the account's own
 * calendar (`weekJustEnding`: the Monday of the week holding the local date less one day), so a
 * zone already on Monday (London, Kiritimati) gets the week that ended, not the one starting.
 * A POST is an explicit run and starts a fresh pass; the
 * per-user week lock still skips whoever already ran.
 */
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { blockedFrom, type ExpenditureResult } from "@/lib/expenditure";
import { buildProposal } from "@/lib/proposal";
import { activeProfile } from "@/lib/server/targets";
import {
  ACCOUNT_DAY_LAST_RESORT_ZONE, readAccountZone, resolveAccountDay,
} from "@/lib/server/account-day";
import { runEstimate, timeZoneFor, upsertEstimate } from "@/lib/server/expenditure";
import { mergedDays, weighInsKg } from "@/lib/server/health-daily";
import {
  accountIds, claimLock, cronSecretOk, DEFAULT_TZ, releaseLock, weekJustEnding,
} from "@/lib/server/jobs";
import {
  BUDGET_MS, HARD_STOP_MS, listOf, markPass, sweep, utcDate,
} from "@/lib/server/job-cursor";
import type { JobResponse, TargetProfile } from "@/lib/api-types";
import { readTargetEligibility } from "@/lib/server/target-eligibility";
import { paceAllowed } from "@/lib/profile/rate-eligibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const JOB_NAME = "weekly-proposal";
const CONCURRENCY = 6;

async function writeProposal(
  admin: ReturnType<typeof adminClient>, userId: string, weekStart: string,
  estimate: ExpenditureResult, active: TargetProfile, asOf: string,
): Promise<"proposed" | "none"> {
  // Pace holds (onboarding v2 G1): a held account's proposal follows its burn at a 0 pace, even
  // when the revision in force predates the hold. A minor's revision proposes nothing, even one
  // already at a 0 pace (a maintenance goal, or a stale revision left behind by a later-added
  // minor profile) — the minor check must never be skipped just because the rate is already 0.
  let held = active;
  const eligibility = await readTargetEligibility(admin, userId, asOf);
  if (eligibility.minor) return "none";
  if (Number(active.goal_rate_bp_week ?? 0) !== 0 && !paceAllowed(eligibility)) {
    held = { ...active, goal_rate_bp_week: 0 };
  }
  const built = buildProposal({ estimate, active: held });

  if (built.kind === "blocked") {
    await upsertEstimate(admin, userId, asOf, blockedFrom(estimate, built.reason));
    return "none";
  }
  if (built.kind === "none") return "none";

  const { data: est } = await admin.from("expenditure_estimates").select("id")
    .eq("user_id", userId).eq("local_date", asOf).maybeSingle();

  // write_target_proposal (ruling 7) rejects every other pending proposal for this user and
  // inserts the new one in one transaction — no more separate insert-then-update. `on conflict
  // (user_id, week_start) do nothing` keeps the same-week idempotency the spec's acceptance
  // criterion 5 measures: a retry for a week that already has a row returns null, not an error.
  const { data, error } = await admin.rpc("write_target_proposal", {
    p_user_id: userId, p_week_start: weekStart,
    p_based_on_estimate_id: est?.id ?? null, p_proposed: built.proposed,
  });
  if (error) throw error;
  return data ? "proposed" : "none";
}

const WEEK_START_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A manual retry of a missed Sunday run otherwise always lands in mondayOf(asOf) — whichever week
 * wall-clock "now" happens to fall in — which permanently orphans the week that actually failed
 * (finding #54). An explicit `{ "weekStart": "yyyy-mm-dd" }` body lets the retry target that week.
 */
async function weekStartOverride(req: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return null;
  }
  const weekStart = (body as { weekStart?: unknown } | null)?.weekStart;
  return typeof weekStart === "string" && WEEK_START_RE.test(weekStart) ? weekStart : null;
}

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (!cronSecretOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    await enforceRateLimit("jobs:weekly-proposal", 10, 3600);
    if (!process.env.ESTIMATOR_ENABLED) {
      throw new HttpError(503, "unavailable", "ESTIMATOR_ENABLED is off");
    }
    const admin = adminClient();
    const requestedWeekStart = await weekStartOverride(req);
    const out: JobResponse = { ran: 0, skipped: 0, errors: 0 };

    const proposeOne = async (
      userId: string, { passStartedAt }: { passStartedAt: Date },
    ): Promise<"ok" | "skip" | "retry"> => {
      let weekStart: string | null = null;
      let hasLock = false;
      try {
        // The estimate and the target lookup run on the account's own day (t24b): its stored zone,
        // else UTC as the logged last resort, never the deployment-wide HEALTH_TZ. The week
        // boundary keeps the cron zone chain (`timeZoneFor`): `weekStartOf` in lib/server/jobs.ts
        // promises the weekly-review job computes this same week_start, and that job is unchanged.
        const day = resolveAccountDay({ purpose: "weekly-proposal job", now: passStartedAt,
          storedZone: await readAccountZone(admin, userId) });
        const asOf = day.date;
        const weekZone = await timeZoneFor(admin, userId);
        weekStart = requestedWeekStart ?? weekJustEnding(weekZone || DEFAULT_TZ, passStartedAt);
        const lock = await claimLock(admin, JOB_NAME, userId, weekStart);
        if (lock !== "taken") {
          out.skipped += 1;
          return lock === "done" ? "skip" : "retry";
        }
        hasLock = true;
        const estimate = await runEstimate(admin, userId, asOf, {
          weighIns: weighInsKg,
          activityDays: mergedDays,
          timeZone: day.zone ?? ACCOUNT_DAY_LAST_RESORT_ZONE,
        });
        const active = await activeProfile(admin, userId, asOf);
        const written = active
          ? await writeProposal(admin, userId, weekStart, estimate, active, asOf)
          : "none";
        await releaseLock(admin, JOB_NAME, userId, weekStart, "ok",
          { status: estimate.status, written });
        out.ran += 1;
        return "ok";
      } catch (e) {
        if (hasLock && weekStart) {
          await releaseLock(admin, JOB_NAME, userId, weekStart, "error",
            { message: e instanceof Error ? e.message : "unknown" });
        }
        console.error("weekly proposal job failed for user", { userId, error: e });
        out.errors += 1;
        return "retry";
      }
    };

    const pass = await sweep(admin, {
      job: JOB_NAME, restart: req.method === "POST",
      period: requestedWeekStart ? `week-${requestedWeekStart}` : utcDate(new Date(startedAt)),
      list: (after) => accountIds(admin, after), byKeys: listOf, keyOf: (userId) => userId,
      concurrency: CONCURRENCY, deadline: startedAt + BUDGET_MS,
      hardStop: startedAt + HARD_STOP_MS, work: proposeOne,
      onError: (userId, error) => {
        out.errors += 1;
        console.error("weekly proposal job failed for user", { userId, error });
      },
    });
    markPass(out, pass);
    return Response.json(out);
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = POST;
