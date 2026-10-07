import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { readCareMessages } from "@/lib/server/care-messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** UI-NEEDS SPROUT-CARE item 4: GET /api/care/messages[?unread=1] -> `{ messages }`. Dismissed
 *  messages are never returned. 401 without a session. No-store. */
export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`care-messages:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`care-messages:${userId}`, 60, 60);
    const unread = new URL(req.url).searchParams.get("unread") === "1";
    const messages = await readCareMessages(client, userId, unread);
    return Response.json({ messages }, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
