import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { tasteChipsEnabled } from "@/lib/server/taste-chips";
import { undoTasteChips } from "@/lib/server/taste-confirm";
import { tasteUndoRequestSchema } from "@/lib/profile/taste-confirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Phase 18 W5b-2: undo one taste-chip confirmation by its action id, from the server receipt only:
 * removes the keys THAT confirm added and that are still present; a key removed since stays removed
 * and is reported in `gone`. A second Undo answers `already_undone` and writes nothing. Body
 * `{ actionId }`. 200 `{ status: "undone" | "already_undone", actionId, removed, gone, undoneAt,
 * settings }`; 400; 401; 404 not_enabled | unknown_action; 409 settings_unreadable | account_mismatch;
 * 413; 429; 502 taste_confirm_failed; 503. No-store. Dark until `TASTE_CHIPS_ENABLED=1`.
 * A coach card's Undo also closes through `POST /api/coach/undo/{id}` (record_mode taste_v1).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`taste-undo:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`taste-undo:${userId}`, 30, 60);
    if (!tasteChipsEnabled()) throw new HttpError(404, "not_enabled", "Taste chips are not available yet.");
    const { actionId } = await readJson(req, tasteUndoRequestSchema, 1024);
    return Response.json(await undoTasteChips(client, userId, actionId), { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
