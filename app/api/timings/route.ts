/**
 * POST /api/timings — JWT, 8 KB, 60/min (T0 §1).
 *
 * The batched client marks from lib/timing.ts. The rows are inserted with THEIR client, so
 * `client_timings`' insert policy is the tenancy boundary and `user_id` is stamped here from the
 * session, never read off the body. Answers 202 whatever the insert does: a lost measurement is
 * a gap in a p95 table, not something to fail a phone tap over.
 */

import { z } from "zod";
import { TIMING_PATHS, TIMING_STEPS } from "@/lib/timing";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024;
/** One run is at most ten steps; 200 rows is a burst of runs, not a firehose. */
const MAX_ROWS = 200;

const Body = z.object({
  rows: z.array(z.object({
    run_id: z.uuid(),
    path: z.enum(TIMING_PATHS),
    step: z.enum(TIMING_STEPS),
    ms: z.number().int().min(0).max(600_000),
    at: z.iso.datetime(),
    device: z.string().max(200).optional(),
  })).min(1).max(MAX_ROWS),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const ip = requestIp(req);
    await enforceRateLimit(`timings:ip:${ip}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`timings:user:${userId}`, 60, 60);
    const body = await readJson(req, Body, MAX_BYTES);
    const { error } = await client.from("client_timings").insert(
      body.rows.map((row) => ({
        user_id: userId, run_id: row.run_id, path: row.path, step: row.step,
        ms: row.ms, at: row.at, device: row.device ?? null,
      })),
    );
    if (error) console.error("client_timings insert failed", { userId, error });
    return new Response(null, { status: 202 });
  } catch (e) {
    return jsonError(e);
  }
}
