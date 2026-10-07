/**
 * POST /api/pantry/photo — JWT, 2 KB (a media path only), 10/min/user.
 *
 * W12 draft step (docs/specs/phase-18-open-world-foods.md §W12, acceptance 1): reads the
 * already-uploaded photo (same bucket and 24-hour sweep as every other media capture,
 * lib/server/media.ts), asks `photoToIdeas` what it shows, and returns the ingredient names it
 * recognised. Writes 0 `shopping_pantry` rows — only POST /api/pantry/photo/confirm does that,
 * and only for the items the user confirms.
 */
import { z } from "zod";
import { adminClient } from "@/lib/server/admin";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { draftPantryPhoto } from "@/lib/server/pantry-photo";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["sfo1"];
export const maxDuration = 15;

const MAX_BYTES = 2 * 1024;
const Body = z.object({ mediaPath: z.string().min(1).max(200) });

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    await enforceRateLimit(`pantry:photo:user:${userId}`, 10, 60);
    const body = await readJson(req, Body, MAX_BYTES);
    const draft = await draftPantryPhoto(adminClient(), userId, body.mediaPath);
    return Response.json(draft, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return jsonError(e);
  }
}
