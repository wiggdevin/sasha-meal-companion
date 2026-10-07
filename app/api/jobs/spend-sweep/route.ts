/**
 * GET|POST /api/jobs/spend-sweep — Vercel cron every 15 minutes (scale S2).
 *
 * An unsettled AI spend hold keeps counting against both daily caps until it is settled or
 * reconciled (migration 20261218090100), so expired holds must not wait for chance: this job
 * runs the bounded `ai_spend_sweep` again and again until no expired hold remains or its 60 s
 * budget ends. Each pass reconciles at most PASS_MAX holds (charging the call's ai_calls cost,
 * else the whole hold) and prunes old history. A user's own expired holds are also reconciled
 * inline by `ai_spend_reserve`; this job clears everyone else's, which only the global ceiling
 * sees.
 *
 * The cron secret is checked before the rate limit, as every job (scale S2); the limit fails closed.
 * Vercel's scheduler issues GET, so both verbs share one handler.
 */

import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { cronSecretOk } from "@/lib/server/jobs";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const BUDGET_MS = 60_000;
/** Small passes: each RPC is one transaction holding shard and user locks, so keep it short. */
const PASS_MAX = 50;

async function rpcNumber(admin: ReturnType<typeof adminClient>, fn: string,
  args: Record<string, unknown> = {}): Promise<number> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new HttpError(500, "internal", `${fn} failed`, { cause: error });
  const n = Number(data);
  if (!Number.isFinite(n)) throw new HttpError(500, "internal", `${fn} returned no number`);
  return n;
}

async function run(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (!cronSecretOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    await enforceRateLimit("jobs:spend-sweep", 12, 3600);
    const admin = adminClient();
    let passes = 0;
    let remaining = await rpcNumber(admin, "ai_spend_expired_count");
    while (remaining > 0 && Date.now() - startedAt < BUDGET_MS) {
      const worked = await rpcNumber(admin, "ai_spend_sweep", { p_max: PASS_MAX });
      passes += 1;
      const left = await rpcNumber(admin, "ai_spend_expired_count");
      // Another sweep holds the single-flight lock, or nothing moved: try again next run.
      if (worked === 0 && left >= remaining) { remaining = left; break; }
      remaining = left;
    }
    if (remaining > 0) {
      console.warn("spend sweep stopped with expired holds left; the next run continues", {
        remaining, passes,
      });
    }
    return Response.json({ passes, remaining });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = run;
export const POST = run;
