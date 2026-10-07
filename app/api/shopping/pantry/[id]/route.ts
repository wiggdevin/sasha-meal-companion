import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { removePantry } from "@/lib/shopping/repository";
import { id, requestId, revision } from "@/lib/shopping/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ expectedRevision: revision, requestId });
export async function DELETE(req: Request,
  context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    const itemId = (await context.params).id;
    if (!id.safeParse(itemId).success) throw new HttpError(400, "bad_request", "Invalid pantry ID.");
    const body = await readJson(req, Body, 1024);
    await removePantry(client, userId, itemId, body.expectedRevision, body.requestId);
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
