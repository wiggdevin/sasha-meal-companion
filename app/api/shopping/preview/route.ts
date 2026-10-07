import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { markShoppingItems } from "@/lib/server/shopping-rule-marks";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { noStore, previewShopping } from "@/lib/server/recipe-plan";
import { shoppingPreviewBody } from "@/lib/shopping/preview-contract";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-preview:${userId}`, 12, 60);
    const body = await readJson(req, shoppingPreviewBody, 18000);
    const preview = await previewShopping(client, userId, body);
    const lines = await markShoppingItems(client, userId, preview.lines);
    return Response.json({ ...preview, lines }, { headers: noStore });
  } catch (error) { return jsonError(error); }
}
