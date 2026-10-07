import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { resolveCareDay } from "@/lib/server/care-zone";
import { purchaseCareItem } from "@/lib/server/care-shop";
import { carePurchaseRequestSchema } from "@/lib/care/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * UI-NEEDS SPROUT-CARE item 2: POST /api/care/purchase `{ itemId, actionId }` -> atomic debit +
 * grant, idempotent on `actionId` (a retry answers the first receipt). 200 `{ status: applied |
 * existing, receipt }` | `{ status: unknown_item | owned | action_conflict }` | `{ status:
 * insufficient, short }`. 401 without a session. No-store.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`care-purchase:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`care-purchase:${userId}`, 20, 60);
    const body = await readJson(req, carePurchaseRequestSchema, 2 * 1024);
    const day = await resolveCareDay(client, userId, "POST /api/care/purchase",
      new URL(req.url).searchParams.get("date"));
    const result = await purchaseCareItem(client, userId, body.itemId, body.actionId, day.date, day.zone);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
