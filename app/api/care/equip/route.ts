import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { equipCareItem } from "@/lib/server/care-shop";
import { careEquipRequestSchema } from "@/lib/care/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * UI-NEEDS SPROUT-CARE item 2: POST /api/care/equip `{ slot, itemId: string | null, rev? }` ->
 * `{ status: ok | conflict | not_owned | wrong_slot, equipped, rev }`. A mismatched `rev` answers
 * `conflict` with the current state instead of applying. 401 without a session. No-store.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`care-equip:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`care-equip:${userId}`, 30, 60);
    const body = await readJson(req, careEquipRequestSchema, 2 * 1024);
    const result = await equipCareItem(client, userId, body.slot, body.itemId, body.rev ?? null);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
