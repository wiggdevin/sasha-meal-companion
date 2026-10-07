import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { markShoppingItems } from "@/lib/server/shopping-rule-marks";
import { patchLine } from "@/lib/shopping/repository";
import { id, linePatch, requestId, revision } from "@/lib/shopping/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; lineId: string }> };
const Edit = z.object({ expectedRevision: revision, requestId, patch: linePatch });
const Remove = z.object({ expectedRevision: revision, requestId });
async function ids(context: Context) {
  const params = await context.params;
  if (!id.safeParse(params.id).success || !id.safeParse(params.lineId).success)
    throw new HttpError(400, "bad_request", "Invalid shopping line ID.");
  return params;
}
export async function PATCH(req: Request, context: Context): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-lines:${userId}`, 60, 60);
    const { id: periodId, lineId } = await ids(context);
    const body = await readJson(req, Edit, 30_000);
    const saved = await patchLine(client, userId, periodId, lineId,
      body.expectedRevision, body.requestId, body.patch);
    const [line] = await markShoppingItems(client, userId, [saved]);
    return Response.json({ line }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
export async function DELETE(req: Request, context: Context): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-lines:${userId}`, 60, 60);
    const { id: periodId, lineId } = await ids(context);
    const body = await readJson(req, Remove, 1024);
    await patchLine(client, userId, periodId, lineId,
      body.expectedRevision, body.requestId, {}, true);
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
