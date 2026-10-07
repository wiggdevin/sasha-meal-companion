import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { resolveCareDay } from "@/lib/server/care-zone";
import { readCareAccolades, syncCareAccolades } from "@/lib/server/care-accolades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * UI-NEEDS SPROUT-CARE item 3: GET /api/care/accolades[?unseen=1] -> `{ accolades }`. Recomputes
 * and grants every rule this backend can derive before answering (see migration
 * 20261225090300_care_accolades.sql for which rules that is today). 401 without a session.
 * No-store.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`care-accolades:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`care-accolades:${userId}`, 60, 60);
    const url = new URL(req.url);
    const day = await resolveCareDay(client, userId, "GET /api/care/accolades", url.searchParams.get("date"));
    await syncCareAccolades(client, userId, day.date, day.zone);
    const accolades = await readCareAccolades(client, userId, url.searchParams.get("unseen") === "1");
    return Response.json({ accolades }, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
