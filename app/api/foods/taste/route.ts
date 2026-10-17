import { requireUser } from "@/lib/server/auth";
import { accountDay } from "@/lib/server/account-day";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { accountTaste, DEFAULT_TASTE_PORTS } from "@/lib/server/taste-admission";
import { favorableResolver } from "@/lib/server/taste-favor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 18 W3: the caller's own eaten history as taste evidence (lib/server/taste-admission.ts),
 * up to 50 admitted identities, each with `favorable` from the shared Favor plan
 * (lib/server/taste-favor.ts). `?date=YYYY-MM-DD` is the phone's local day; without a plausible one
 * the account's stored zone dates the window (lib/server/account-day.ts).
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`foods-taste:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`foods-taste:${userId}`, 20, 60);
    const day = await accountDay(client, userId, { purpose: "GET /api/foods/taste",
      clientDay: new URL(req.url).searchParams.get("date") });
    const body = await accountTaste(client, userId, day.date, DEFAULT_TASTE_PORTS, new Date(),
      favorableResolver(client, userId));
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
