import { rateLimitKey } from "@/lib/server/capture-rate-limit";
/**
 * POST /api/log/propose — JWT, 8 KB (refs only), burst 30/min, daily caps from ai_calls (§5).
 *
 * The route decides nothing about capture: contracts §8 order (rate limit, identity, body), then
 * proposeDraft, then the spec §5 error table. A 409 is the one body that carries a third field.
 */

import { proposeRequestSchema } from "@/lib/capture/types";
import { adminClient } from "@/lib/server/admin";
import { requireUser } from "@/lib/server/auth";
import { DuplicateRequest, proposeDraft } from "@/lib/server/capture";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// T0 §5: fluid-compute function config. The region is pinned to the Supabase project's own
// (us-west-1 -> sfo1, as vercel.json "regions") so every query in this route is a short hop,
// and `maxDuration` is the client budget in lib/fetch-with-deadline.ts plus room for the
// response, never more.
export const preferredRegion = ["sfo1"];
export const maxDuration = 30;

const MAX_BYTES = 8 * 1024;

export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(rateLimitKey(req), 30, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`log:propose:user:${userId}`, 30, 60);
    const body = await readJson(req, proposeRequestSchema, MAX_BYTES);
    return Response.json(await proposeDraft(client, adminClient(), userId, body));
  } catch (e) {
    if (e instanceof DuplicateRequest) {
      return Response.json({ error: e.code, message: e.message, aiCallId: e.aiCallId },
        { status: 409 });
    }
    return jsonError(e);
  }
}
