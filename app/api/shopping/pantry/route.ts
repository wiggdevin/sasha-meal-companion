import { z } from "zod";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { markShoppingItems } from "@/lib/server/shopping-rule-marks";
import { listPantry, putPantry } from "@/lib/shopping/repository";
import { pantryDraft, requestId, revision } from "@/lib/shopping/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ requestId, item: pantryDraft, expectedRevision: revision.nullable() });
export async function GET(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-pantry:${userId}`, 60, 60);
    const items = await markShoppingItems(client, userId, await listPantry(client, userId));
    return Response.json({ items },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
export async function PUT(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-pantry:${userId}`, 60, 60);
    const body = await readJson(req, Body, 4000);
    const saved = await putPantry(client, userId, body.item, body.expectedRevision, body.requestId);
    const [item] = await markShoppingItems(client, userId, [saved]);
    return Response.json({ item }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
