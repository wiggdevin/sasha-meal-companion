/**
 * DELETE empties a saved chat's transcript in place: every coach_messages row for that thread is
 * removed, the thread's rolling summary and last_message_at are cleared, and its title survives.
 * ai_calls is never touched — it is billing history, not conversation state. A saved chat or the
 * weekly-review thread qualifies (clearing a review thread also clears its unread mark); a plan
 * thread or another user's thread 404s like an unknown id.
 */

import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { coachEnabled } from "@/lib/capabilities";
import { clearChatThread } from "@/lib/server/coach-threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function assertEnabled(): void {
  if (!coachEnabled()) throw new HttpError(404, "not_found", "No such route.");
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertEnabled();
    await enforceRateLimit(`coach:thread:messages:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:thread:messages:${userId}`, 60, 60);
    const { id } = await ctx.params;
    await clearChatThread(client, userId, id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return jsonError(e);
  }
}
