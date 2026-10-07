/**
 * POST /api/coach/transcribe — one clip, one transcript (T7 §2).
 *
 * JWT, an 8 KB body (it carries one storage path), and the same pre-identity flood brake
 * /api/coach uses. Nothing is written: the reply is the words, and the phone puts them in the
 * textarea for them to read before the user sends them.
 */

import { requireUser } from "@/lib/server/auth";
import { adminClient } from "@/lib/server/admin";
import { transcribeAudio, transcribeRequestSchema } from "@/lib/server/coach-transcribe";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Supabase project's own region (us-west-1 -> sfo1), like every other hot route (T0 §5);
// `maxDuration` is the client's 8 s `transcribe` budget plus room for the response, never more.
export const preferredRegion = ["sfo1"];
export const maxDuration = 15;

const MAX_BODY_BYTES = 8 * 1024;

export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`coach:transcribe:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId } = await requireUser(req);
    const body = await readJson(req, transcribeRequestSchema, MAX_BODY_BYTES);
    return Response.json(await transcribeAudio(adminClient(), userId, body));
  } catch (e) {
    return jsonError(e);
  }
}
