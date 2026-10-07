import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { markShoppingItems } from "@/lib/server/shopping-rule-marks";
import { getPeriod, patchPeriod } from "@/lib/shopping/repository";
import { id, periodPatch, requestId, revision } from "@/lib/shopping/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const Body = z.object({ expectedRevision: revision, requestId, patch: periodPatch });

async function periodId(context: Context): Promise<string> {
  const value = (await context.params).id;
  if (!id.safeParse(value).success) throw new HttpError(400, "bad_request", "Invalid period ID.");
  return value;
}

export async function GET(req: Request, context: Context): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-period-item:${userId}`, 60, 60);
    const body = await getPeriod(client, userId, await periodId(context));
    const lines = await markShoppingItems(client, userId, body.lines);
    return Response.json({ ...body, lines }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
export async function PATCH(req: Request, context: Context): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-period-item:${userId}`, 60, 60);
    const body = await readJson(req, Body, 6000);
    const period = await patchPeriod(client, userId, await periodId(context),
      body.expectedRevision, body.requestId, body.patch);
    return Response.json({ period }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
