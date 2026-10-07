import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { tasteChipsEnabled } from "@/lib/server/taste-chips";
import { confirmTasteChips } from "@/lib/server/taste-confirm";
import { tasteConfirmRequestSchema, type TasteConfirmRequest } from "@/lib/profile/taste-confirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Phase 18 W5b-2: write the taste chips the user confirmed (lib/profile/taste-confirm.ts). Body
 * `{ actionId, source, dislikes, cuisines, coach? }`. 200 `{ status: "applied" | "existing",
 * actionId, added, present, capped, undoneAt, settings }`; 400 bad_request; 401; 404 not_enabled |
 * unknown_proposal; 409 action_conflict | settings_not_synced | settings_unreadable | account_mismatch;
 * 413; 422 chip_not_proposed; 429; 502 taste_confirm_failed; 503 rate_limit_unavailable. No-store.
 * Dark until `TASTE_CHIPS_ENABLED=1`. No model call.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`taste-confirm:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`taste-confirm:${userId}`, 30, 60);
    if (!tasteChipsEnabled()) throw new HttpError(404, "not_enabled", "Taste chips are not available yet.");
    const body = await readJson(req, tasteConfirmRequestSchema, 8 * 1024) as TasteConfirmRequest;
    return Response.json(await confirmTasteChips(client, userId, body), { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
