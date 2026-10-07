import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { accountDay } from "@/lib/server/account-day";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { favorTasteKey, RulesChangedError } from "@/lib/server/taste-favor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FavorRequest = z.object({ key: z.string() }).strict();
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Phase 18 D6: favor one "Eaten often" identity (lib/server/taste-favor.ts). Body `{ key }` only,
 * a key from the caller's own `GET /api/foods/taste` items; `?date=YYYY-MM-DD` is the phone's day,
 * as for that route. 200 `{ favored: true, refs, skippedAvoid, rulesRevision }`; 400 bad_request;
 * 401; 404 unknown_key; 409 rule_review_required | membership_changed | rules_changed
 * `{ rulesVersion }`; 413; 422 nothing_to_favor; 429 rate_limited; 503. Always no-store.
 * The limiter is the repo's per-instance one (lib/server/ratelimit.ts), as on every account route.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`foods-favor:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`foods-favor:${userId}`, 30, 60);
    const { key } = await readJson(req, FavorRequest, 4 * 1024);
    const day = await accountDay(client, userId, { purpose: "POST /api/foods/favor",
      clientDay: new URL(req.url).searchParams.get("date") });
    const body = await favorTasteKey(client, userId, key, day.date);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof RulesChangedError) {
      return Response.json({ error: error.code, message: error.message, rulesVersion: error.rulesVersion },
        { status: 409, headers: NO_STORE });
    }
    const res = jsonError(error);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
