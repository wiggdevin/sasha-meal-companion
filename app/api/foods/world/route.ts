import { requireUser } from "@/lib/server/auth";
import { adminClient } from "@/lib/server/admin";
import { foodWorldRequest, readFoodWorld, setFoodWorld } from "@/lib/server/food-world";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * W13: this account's own current `food_world`, for Settings and the starter-seed gate
 * (lib/foods/today-starter.ts) — an open account seeds no default Favored foods. Side-effect
 * free, private, no-store, same shape as `POST`'s 200 body.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    const world = await readFoodWorld(adminClient(), userId);
    return Response.json({ world }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Phase 18 W2b: switch this account's food world (`{ world, confirmations? }`). 200 `{ world }`,
 * 409 `condition_review { conditions }`, or 423 `held` / `open_world_not_released`. The identity
 * comes from the session only; lib/server/food-world.ts names it on every read and write.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`food-world:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId } = await requireUser(req);
    await enforceRateLimit(`food-world:${userId}`, 10, 60);
    const body = await readJson(req, foodWorldRequest, 8 * 1024);
    const result = await setFoodWorld(adminClient(), userId, body);
    return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
