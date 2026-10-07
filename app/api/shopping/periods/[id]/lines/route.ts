import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { markShoppingItems } from "@/lib/server/shopping-rule-marks";
import { createLine } from "@/lib/shopping/repository";
import { id, lineDraft, requestId } from "@/lib/shopping/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ requestId, line: lineDraft });
export async function POST(req: Request,
  context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-lines:${userId}`, 60, 60);
    const periodId = (await context.params).id;
    if (!id.safeParse(periodId).success) throw new HttpError(400, "bad_request", "Invalid period ID.");
    const body = await readJson(req, Body, 30_000);
    // Never refused for a rule: the line is saved and comes back with its current-rule mark.
    const saved = await createLine(client, userId, periodId, body.line, body.requestId);
    const [line] = await markShoppingItems(client, userId, [saved]);
    return Response.json({ line }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
