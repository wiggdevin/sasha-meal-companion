import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { readRulesToken } from "@/lib/server/rules-clock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 18 D11, W2b: `{ rulesVersion, evidenceVersion }`, the two freshness counters, read on the
 * caller's own RLS client. The phone asks before any new suggestion; a moved counter means its
 * admitted set is stale and must be refetched (lib/foods/world/rules-version-client.ts).
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`rules-version:pre:ip:${requestIp(req)}`, 300, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`rules-version:${userId}`, 60, 60);
    return Response.json(await readRulesToken(client, userId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
