/**
 * POST /api/pantry/photo/confirm — JWT, 4 KB, 10/min/user.
 *
 * W12 confirm step (acceptance 2, 3): writes one `shopping_pantry` row per confirmed item,
 * `source: 'photo'`, null grams allowed. The written rows are returned through
 * `markShoppingItems` — the same rule-mark pass GET /api/shopping/pantry runs — so a blocked or
 * unverified item comes back marked, never silently dropped, and this route makes no allergen
 * judgement of its own.
 */
import { z } from "zod";
import { requestId as requestIdSchema } from "@/lib/shopping/validation";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { confirmPantryPhoto } from "@/lib/server/pantry-photo";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { markShoppingItems } from "@/lib/server/shopping-rule-marks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["sfo1"];
export const maxDuration = 15;

const MAX_BYTES = 4 * 1024;
const Body = z.object({
  requestId: requestIdSchema,
  items: z.array(z.object({ name: z.string().min(1).max(160),
    grams: z.number().nonnegative().nullable() })).min(1).max(40),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`pantry:photo:confirm:user:${userId}`, 10, 60);
    const body = await readJson(req, Body, MAX_BYTES);
    const written = await confirmPantryPhoto(client, userId, body.items, body.requestId);
    const items = await markShoppingItems(client, userId, written);
    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return jsonError(e);
  }
}
