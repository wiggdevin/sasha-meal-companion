import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { undoRemoveTasteDislike } from "@/lib/server/taste-dislike-remove";
import { tasteDislikeRemoveUndoRequestSchema } from "@/lib/profile/taste-dislike-remove";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Followups #1: exact Undo of one remove-one-dislike action, from the server receipt only —
 * restores the key only while this action actually removed it and it is still absent; a key
 * re-added some other way since is left alone (`restored: false`). A second Undo answers
 * `already_undone` and writes nothing.
 *
 * Body `{ actionId }`. 200 `{ status: "undone" | "already_undone", actionId, key, restored,
 * capped, settings }`; 400; 401; 404 unknown_action; 409 settings_unreadable; 413; 429; 502
 * taste_dislike_remove_failed; 503. No-store.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`taste-dislike-undo:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`taste-dislike-undo:${userId}`, 30, 60);
    const { actionId } = await readJson(req, tasteDislikeRemoveUndoRequestSchema, 1024);
    const result = await undoRemoveTasteDislike(client, userId, actionId);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
