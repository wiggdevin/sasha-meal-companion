import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { removeTasteDislike } from "@/lib/server/taste-dislike-remove";
import {
  tasteDislikeRemoveRequestSchema, type TasteDislikeRemoveRequest,
} from "@/lib/profile/taste-dislike-remove";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Followups #1: drop one confirmed taste dislike (lib/server/taste-dislike-remove.ts). Owner-
 * scoped (the caller's own session), idempotent on `actionId`. Not gated by `TASTE_CHIPS_ENABLED`
 * — a dislike pill can already exist from the sync path with chips off.
 *
 * Body `{ actionId, key }`. 200 `{ status: "removed" | "already_gone" | "existing", actionId, key,
 * settings }`; 400 bad_request; 401; 409 action_conflict | settings_not_synced |
 * settings_unreadable; 413; 429; 502 taste_dislike_remove_failed; 503 rate_limit_unavailable.
 * No-store. No model call.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`taste-dislike-remove:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`taste-dislike-remove:${userId}`, 30, 60);
    const body = await readJson(req, tasteDislikeRemoveRequestSchema, 1024) as TasteDislikeRemoveRequest;
    const result = await removeTasteDislike(client, userId, body.actionId, body.key);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
