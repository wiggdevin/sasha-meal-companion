/**
 * POST /api/media/sign — JWT, 1 KB, 30/min/user (§5). The path is built server-side from
 * auth.uid(); the body carries only kind, contentType and the declared size.
 */

import { assertGeminiAttested } from "@/lib/ai/attestation";
import { signRequestSchema } from "@/lib/capture/types";
import { adminClient } from "@/lib/server/admin";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { signUpload } from "@/lib/server/media";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const ip = requestIp(req);
    await enforceRateLimit(`media:sign:ip:${ip}`, 30, 60);
    const { userId } = await requireUser(req);
    await enforceRateLimit(`media:sign:user:${userId}`, 30, 60);
    const body = await readJson(req, signRequestSchema, 1024);
    // Phase 13 §9 R3: every signed upload is model-bound (capture or transcription). Without the
    // attestation nothing may be uploaded at all, so the gate runs before a URL is issued.
    assertGeminiAttested();
    return Response.json(await signUpload(adminClient(), userId, body));
  } catch (e) {
    return jsonError(e);
  }
}
