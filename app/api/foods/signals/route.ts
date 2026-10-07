import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { FoodSignalBatch, SIGNAL_BODY_MAX_BYTES, partitionSignals } from "@/lib/foods/signals";
import { issuedFoodKey, ownedFoodKeyCheck, recordFoodSignals, SignalStoreError } from "@/lib/server/food-signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Phase 18 W6: taps on offered foods, with their offered slates (lib/foods/signals.ts is the wire
 * contract). Body `{ events: FoodSignalEvent[] }`, 1 to 20 events, at most 48 KB.
 *
 * 202 `{ accepted, rejected }` whatever the insert does, so a tap is never blocked: `rejected`
 * counts events refused here (a food outside its offered slate, a food key or ranking version the
 * app never issued, a `food:<uuid>` key that is not one of the caller's own `user_foods` rows (one
 * owner-scoped read per batch; another account's id and a missing id are refused alike), a clock more than 10 minutes
 * ahead or 14 days behind, a local date more than a day from the event's UTC date); `accepted` is
 * what was handed to the store. A failed insert is logged with its error code only (no keys, no
 * user id) and still answers 202. 400 bad_request (not JSON or not the shape); 401; 413; 429
 * rate_limited (120/min per IP before auth, 60/min per account, the shared Postgres limiter, fail
 * closed); 503 rate_limit_unavailable. Always no-store.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`foods-signals:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`foods-signals:${userId}`, 60, 60);
    const { events } = await readJson(req, FoodSignalBatch, SIGNAL_BODY_MAX_BYTES);
    const now = Date.now();
    const shaped = partitionSignals(events, now, issuedFoodKey);
    const owned = await ownedFoodKeyCheck(client, userId, shaped.eligible);
    const { eligible, rejected: notOwned } = partitionSignals(shaped.eligible, now, owned);
    const rejected = shaped.rejected + notOwned;
    if (eligible.length > 0) {
      try {
        await recordFoodSignals(client, eligible);
      } catch (error) {
        console.warn("food signals: insert failed; answered 202", {
          code: error instanceof SignalStoreError ? error.code : "unexpected", events: eligible.length,
        });
      }
    }
    return Response.json({ accepted: eligible.length, rejected }, { status: 202, headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
