import { effectiveFoodWorld } from "@/lib/foods/world/access";
import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { readRulesToken } from "@/lib/server/rules-clock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 18 D11, W2b: `{ rulesVersion, evidenceVersion, world }`, the two freshness counters and the
 * account's effective food world, read on the caller's own RLS client. The phone asks before any
 * new suggestion; a moved counter means its admitted set is stale and must be refetched
 * (lib/foods/world/rules-version-client.ts). `world` (Sol r2 BLOCK) is `effectiveFoodWorld`: an
 * account taken off `OPEN_WORLD_USER_IDS` or put on hold answers `closed`, so a held open snapshot
 * is not reused. A failed world read answers `closed` (the phone then refetches; never `open`).
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`rules-version:pre:ip:${requestIp(req)}`, 300, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`rules-version:${userId}`, 60, 60);
    const [token, settings] = await Promise.all([
      readRulesToken(client, userId),
      client.from("user_settings").select("food_world").eq("user_id", userId).maybeSingle(),
    ]);
    const stored = settings.error ? null : (settings.data as { food_world?: unknown } | null)?.food_world;
    return Response.json({ ...token, world: effectiveFoodWorld(stored, userId) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
