/**
 * POST /api/shopping/places/stores — named grocery stores near a point (UI makeover W8 §7.4).
 * `{ lat, lon }` → `{ stores: PlaceStore[] }` (lib/shopping/contracts.ts), nearest first, at most
 * 25: within 4 km, once more within 8 km when there are fewer than 3 (lib/server/places.ts). The
 * point is rounded to 2 decimals before it leaves. Shopping pilot only (404 otherwise), 20 per 10
 * minutes per account (fail closed), 256 bytes, no-store. Upstream trouble is 503
 * `places_unavailable`. Nothing is stored.
 */
import { z } from "zod";
import { jsonError, readJson } from "@/lib/server/http";
import { nearbyStores } from "@/lib/server/places";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requireRecipeUser } from "@/lib/server/recipe-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
}).strict();

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireRecipeUser(req);
    await enforceRateLimit(`places-stores:${userId}`, 20, 600);
    const body = await readJson(req, Body, 256);
    const stores = await nearbyStores(body.lat, body.lon);
    return Response.json({ stores }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
