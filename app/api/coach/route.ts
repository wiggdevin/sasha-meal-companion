/**
 * POST /api/coach — one turn. architecture §5: JWT, 16 KB, 60/day and 10/hour per user.
 * Order per contracts §9: rate limit, identity, body. This first limiter is the pre-identity flood
 * brake; the per-user turn budget is reserved inside runTurn (`reserveTurn`, the same database
 * limiter, fail closed) once the turn is known not to be a replay of a saved one (W035).
 */

import { coachTurnRequestSchema } from "@/lib/coach/types";
import { withJevBudget } from "@/lib/ai/request-budget";
import { HttpError } from "@/lib/server/auth";
import { requireUser } from "@/lib/server/auth";
import { adminClient } from "@/lib/server/admin";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { CoachRateLimited } from "@/lib/server/coach";
import { runTurn } from "@/lib/server/coach-turn";
import { COACH_RESPONSE_DEADLINE_MS } from "@/lib/coach/turn";
import { ASSISTANT_NAME } from "@/lib/brand";
import { coachEnabled } from "@/lib/capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// T0 §5: fluid-compute function config. The region is pinned to the Supabase project's own
// (us-west-1 -> sfo1, as vercel.json "regions") so every query in this route is a short hop,
// and `maxDuration` is the client budget in lib/fetch-with-deadline.ts plus room for the
// response, never more.
export const preferredRegion = ["sfo1"];
export const maxDuration = 60;

const MAX_BODY_BYTES = 16 * 1024;

/** The copy the phone already shows for its own deadline, as the retryable 503 it renders. */
function timedOut(): Response {
  return Response.json(
    { error: "timeout", message: `${ASSISTANT_NAME} did not answer in time. Try again.` }, { status: 503 });
}

/**
 * The response by COACH_RESPONSE_DEADLINE_MS after the request arrived, whatever is still running.
 * runTurn's own deadlines normally answer first, with a saved reply; this is the backstop for any
 * hop they do not cover (sign-in, body parsing, a runtime stall) — Sol r4, 2026-09-23. Work still
 * running is left to finish; a saved turn is replayed by the phone's retry of the same message.
 */
async function beforeResponseDeadline(work: Promise<Response>, arrivedAt: number): Promise<Response> {
  void work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Response>((resolve) => {
    timer = setTimeout(() => resolve(timedOut()), Math.max(0, arrivedAt + COACH_RESPONSE_DEADLINE_MS - Date.now()));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request): Promise<Response> {
  // Every deadline counts from here, the moment the phone's own 40 s clock is closest to.
  const arrivedAt = Date.now();
  return withJevBudget(() => beforeResponseDeadline(handle(req, arrivedAt), arrivedAt));
}

async function handle(req: Request, arrivedAt: number): Promise<Response> {
  try {
    // The flag check comes first and answers 404: with the coach off the route does not exist,
    // and a 401 would tell an unauthenticated caller that it does.
    if (!coachEnabled()) throw new HttpError(404, "not_found", "No such route.");
    await enforceRateLimit(`coach:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    const body = await readJson(req, coachTurnRequestSchema, MAX_BODY_BYTES);
    const turn = await runTurn(client, adminClient(), userId, body, { startedAt: arrivedAt });
    // Scoped AI input: echo the scope so the reply can show where it was asked.
    return Response.json(body.scope ? { ...turn, scope: body.scope } : turn);
  } catch (e) {
    if (e instanceof CoachRateLimited) {
      return new Response(
        JSON.stringify({ error: e.code, message: e.message, retryAfterSeconds: e.retryAfterSeconds }),
        { status: 429, headers: {
          "content-type": "application/json", "retry-after": String(e.retryAfterSeconds) } },
      );
    }
    return jsonError(e);
  }
}
