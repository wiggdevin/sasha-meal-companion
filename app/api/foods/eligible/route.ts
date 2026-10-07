import { requireUser } from "@/lib/server/auth";
import { eligibleFoods } from "@/lib/server/eligible-foods";
import { jsonError } from "@/lib/server/http";
import { mealSnapshot } from "@/lib/server/meal-snapshot";
import { mealSnapshotV3 } from "@/lib/server/meal-snapshot-v3";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * v1 (no `v`): the eligible set, unchanged. `?v=2`: the meal snapshot (Phase 17 O2, D2,
 * lib/meals/snapshot.ts) with the same eligible set beside it as `eligible`. `?v=3` (Phase 18 W8,
 * lib/meals/snapshot-v3.ts): an open food-world account's admitted set, ranking data and freshness
 * token; a closed account gets the v2 body byte for byte.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`eligible-foods:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`eligible-foods:${userId}`, 30, 60);
    const version = new URL(req.url).searchParams.get("v");
    const body = version === "3" ? await mealSnapshotV3(client, userId)
      : version === "2" ? await mealSnapshot(client, userId) : await eligibleFoods(client, userId);
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
