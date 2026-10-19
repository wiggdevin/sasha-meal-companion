/**
 * POST /api/shopping/places/geocode — the build flow's area to a point (UI makeover W8 §7.4).
 * `{ q (1–120 characters), country (ISO 3166 alpha-2) }` → `{ lat, lon, label }`, rounded to 2
 * decimals (lib/server/places.ts). A POST body, so the area never sits in a URL. Shopping pilot only
 * (404 otherwise), 10 per 10 minutes per account (fail closed), 1 KB, no-store. Upstream trouble is
 * 503 `places_unavailable`; no match is 404 `place_not_found`. Nothing is stored.
 */
import { z } from "zod";
import { jsonError, readJson } from "@/lib/server/http";
import { geocodePlace } from "@/lib/server/places";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requireRecipeUser } from "@/lib/server/recipe-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  q: z.string().trim().min(1).max(120),
  country: z.string().regex(/^[A-Za-z]{2}$/),
}).strict();

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireRecipeUser(req);
    await enforceRateLimit(`places-geocode:${userId}`, 10, 600);
    const body = await readJson(req, Body, 1024);
    const place = await geocodePlace(body.q, body.country);
    return Response.json(place, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
