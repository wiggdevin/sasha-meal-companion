/**
 * GET|POST /api/jobs/signal-purge — Vercel cron, daily (Phase 18 W6).
 *
 * Food signal events live 180 days (migration 20261219090000): this job deletes older rows in
 * bounded passes of `food_signal_events_purge` (at most PASS_MAX rows each, oldest first, SKIP
 * LOCKED), one pass at a time through the S3 budget runner (lib/server/job-sweep.ts) until a pass
 * deletes less than a full batch or the run's budget ends. No cursor is kept: a purged row leaves
 * the listing, so the next run starts on exactly what is left.
 *
 * The cron secret is checked before the rate limit, as every job (scale S2): the limit is a shared
 * counter an unauthenticated caller must not spend. The limit fails closed. Vercel's scheduler
 * issues GET, so both verbs share one handler.
 */

import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { BUDGET_MS, HARD_STOP_MS } from "@/lib/server/job-cursor";
import { runWithinBudget } from "@/lib/server/job-sweep";
import { cronSecretOk } from "@/lib/server/jobs";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** One pass is one short delete transaction. */
const PASS_MAX = 5_000;

async function run(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (!cronSecretOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    await enforceRateLimit("jobs:signal-purge", 12, 3600);
    const admin = adminClient();
    let purged = 0;
    let more = true;
    // The next pass is listed only after the last one finished with a full batch (concurrency 1).
    async function* passes(): AsyncGenerator<string> {
      for (let n = 1; more; n += 1) yield String(n);
    }
    const outcome = await runWithinBudget({
      items: passes(), keyOf: (pass) => pass, concurrency: 1,
      deadline: startedAt + BUDGET_MS, hardStop: startedAt + HARD_STOP_MS,
      work: async () => {
        const { data, error } = await admin.rpc("food_signal_events_purge", { p_max: PASS_MAX });
        if (error) throw new HttpError(500, "internal", "food_signal_events_purge failed", { cause: error });
        const deleted = Number(data);
        if (!Number.isInteger(deleted) || deleted < 0) {
          throw new HttpError(500, "internal", "food_signal_events_purge returned no count");
        }
        purged += deleted;
        if (deleted < PASS_MAX) more = false;
      },
      onError: (_pass, error) => {
        more = false;
        console.error("signal purge pass failed", {
          code: (error as { cause?: { code?: string } })?.cause?.code ?? "unknown" });
      },
    });
    if (outcome.failed > 0 && purged === 0) {
      throw new HttpError(500, "internal", "signal purge failed");
    }
    const incomplete = more || outcome.failed > 0;
    if (incomplete) console.warn("signal purge stopped early; the next run continues", { purged });
    return Response.json({ purged, passes: outcome.started, ...(incomplete ? { incomplete: true } : {}) });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = run;
export const POST = run;
