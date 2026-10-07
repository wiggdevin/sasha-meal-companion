import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { markCareAccoladesSeen } from "@/lib/server/care-accolades";
import { careAccoladesSeenRequestSchema } from "@/lib/care/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** UI-NEEDS SPROUT-CARE item 3: POST /api/care/accolades/seen `{ keys }` -> `{ marked }`.
 *  A key never earned, or already seen, is silently skipped. 401 without a session. No-store. */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`care-accolades-seen:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`care-accolades-seen:${userId}`, 30, 60);
    const body = await readJson(req, careAccoladesSeenRequestSchema, 2 * 1024);
    const marked = await markCareAccoladesSeen(client, userId, body.keys);
    return Response.json({ marked }, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
