/**
 * POST /api/pantry/photo/confirm — JWT (shopping-pilot gate, same as every other
 * `/api/shopping/*` route), 48 KB, 10/min/user.
 *
 * W12 confirm step (acceptance 2, 3): writes one `shopping_pantry` row per confirmed item,
 * `source: 'photo'`, null grams allowed. The written rows are returned through
 * `markShoppingItems` — the same rule-mark pass GET /api/shopping/pantry runs — so a blocked or
 * unverified item comes back marked, never silently dropped, and this route makes no allergen
 * judgement of its own. One item failing (most often a duplicate-stock 409) never hides whether
 * the others landed: `confirmPantryPhoto` keeps going and this reports both `items` (written,
 * marked) and `failed` (name plus the reason), so a 3-of-5 failure never reads to the caller as
 * a whole-request failure when 2 rows already exist in the pantry.
 */
import { z } from "zod";
import { requestId as requestIdSchema } from "@/lib/shopping/validation";
import { jsonError, readJson } from "@/lib/server/http";
import { confirmPantryPhoto } from "@/lib/server/pantry-photo";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { markShoppingItems } from "@/lib/server/shopping-rule-marks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["sfo1"];
export const maxDuration = 15;

// Followups #21: 40 items x 160-char names (plus grams, punctuation, the requestId) can exceed the
// old 4 KB ceiling; raised to 48 KB on the route. Item caps (40 items, 160 chars) are unchanged —
// this only widens the body-size gate, never the Zod shape. Client-side pre-check: UI-NEEDS #21.
const MAX_BYTES = 48 * 1024;
const Body = z.object({
  requestId: requestIdSchema,
  items: z.array(z.object({ name: z.string().min(1).max(160),
    grams: z.number().nonnegative().nullable() })).min(1).max(40),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireRecipeUser(req);
    await enforceRateLimit(`pantry:photo:confirm:user:${userId}`, 10, 60);
    const body = await readJson(req, Body, MAX_BYTES);
    const { written, failed } = await confirmPantryPhoto(client, userId, body.items, body.requestId);
    const items = await markShoppingItems(client, userId, written);
    return Response.json({ items, failed }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return jsonError(e);
  }
}
