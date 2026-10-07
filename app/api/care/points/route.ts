import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { resolveCareDay } from "@/lib/server/care-zone";
import { readCarePoints, syncCarePoints } from "@/lib/server/care-points";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * UI-NEEDS SPROUT-CARE item 1: GET /api/care/points -> `{ balance, pending, recent }`.
 * Recomputes the caller's own Seeds eligibility for the account's current local day (and its
 * week) before answering, settling whatever has already closed, then reads the ledger through
 * RLS. Optional `?date=YYYY-MM-DD` names the phone's own local day (`accountDay`'s usual chain).
 * 401 without a session. No-store.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`care-points:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`care-points:${userId}`, 60, 60);
    const day = await resolveCareDay(client, userId, "GET /api/care/points",
      new URL(req.url).searchParams.get("date"));
    await syncCarePoints(client, userId, day.date, day.zone);
    return Response.json(await readCarePoints(client, userId), { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
