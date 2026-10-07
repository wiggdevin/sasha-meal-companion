import { z } from "zod";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { markCareMessage } from "@/lib/server/care-messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const idSchema = z.uuid();

/** UI-NEEDS SPROUT-CARE item 4: POST /api/care/messages/{id}/dismiss -> `{ marked }`. Idempotent:
 *  an already-dismissed or unknown id answers `{ marked: false }`, never an error. 401 without a
 *  session. No-store. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await enforceRateLimit(`care-messages-dismiss:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`care-messages-dismiss:${userId}`, 60, 60);
    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) throw new HttpError(400, "bad_request", "Invalid message ID.");
    const marked = await markCareMessage(client, userId, id, "dismiss");
    return Response.json({ marked }, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
