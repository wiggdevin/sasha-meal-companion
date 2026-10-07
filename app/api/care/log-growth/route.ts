import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { resolveCareDay } from "@/lib/server/care-zone";
import { readCareLogGrowth } from "@/lib/server/care-log-growth";
import { careLogGrowthQuerySchema } from "@/lib/care/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * UI-NEEDS SPROUT-CARE item 6: GET /api/care/log-growth?opId=<uuid> -> `{ opId, kind, localDate,
 * grew }`. `opId` is the same deterministic id the log commit response already carries
 * (lib/log/contract.ts opIdFor); `grew` is true only for a genuinely new entry (kind "create",
 * not a synced correction) dated the account's own current local day -- the phone's own cheer
 * signal, never minted from a client-trusted snapshot. 401 without a session. No-store.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`care-log-growth:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`care-log-growth:${userId}`, 60, 60);
    const url = new URL(req.url);
    const parsed = careLogGrowthQuerySchema.safeParse({ opId: url.searchParams.get("opId") });
    if (!parsed.success) throw new HttpError(400, "bad_request", "A valid opId is required.");
    const day = await resolveCareDay(client, userId, "GET /api/care/log-growth", url.searchParams.get("date"));
    return Response.json(await readCareLogGrowth(client, userId, parsed.data.opId, day.zone), { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
