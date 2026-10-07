import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { createPeriod, listPeriods } from "@/lib/shopping/repository";
import { date, periodDraft, requestId } from "@/lib/shopping/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ requestId, period: periodDraft });

export async function GET(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-period-list:${userId}`, 60, 60);
    const params = new URL(req.url).searchParams;
    const start = params.get("start") ?? undefined;
    const end = params.get("end") ?? undefined;
    if ((start && !date.safeParse(start).success) || (end && !date.safeParse(end).success)) {
      throw new HttpError(400, "bad_request", "Check shopping dates.");
    }
    return Response.json({ periods: await listPeriods(client, userId, start, end) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-period:${userId}`, 30, 60);
    const body = await readJson(req, Body, 5000);
    const period = await createPeriod(client, userId, body.period, body.requestId);
    return Response.json({ period }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
