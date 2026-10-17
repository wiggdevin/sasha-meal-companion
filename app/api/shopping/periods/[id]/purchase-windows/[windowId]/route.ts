import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { patchPurchaseWindow } from "@/lib/shopping/repository";
import { id, purchaseWindowPatch, requestId, revision } from "@/lib/shopping/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; windowId: string }> };
const Edit = z.object({ expectedRevision: revision, requestId, patch: purchaseWindowPatch });

export async function PATCH(req: Request, context: Context): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-purchase-window:${userId}`, 60, 60);
    const { id: periodId, windowId } = await context.params;
    if (!id.safeParse(periodId).success || !id.safeParse(windowId).success)
      throw new HttpError(400, "bad_request", "Invalid purchase-window ID.");
    const body = await readJson(req, Edit, 2000);
    const purchaseWindow = await patchPurchaseWindow(client, userId, periodId, windowId,
      body.expectedRevision, body.requestId, body.patch);
    return Response.json({ purchaseWindow }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
