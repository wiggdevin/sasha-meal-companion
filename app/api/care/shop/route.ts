import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { readCareShop } from "@/lib/server/care-shop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** UI-NEEDS SPROUT-CARE item 2: GET /api/care/shop -> `{ items, owned, equipped, rev, balance }`.
 *  `rev` is shop-state.ts's `ShopState.rev`: the token POST /api/care/equip's optional `rev` checks.
 *  401 without a session. No-store. */
export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`care-shop:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`care-shop:${userId}`, 60, 60);
    return Response.json(await readCareShop(client, userId), { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
