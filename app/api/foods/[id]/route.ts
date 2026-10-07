import { z } from "zod";
import { HttpError, requireUser } from "@/lib/server/auth";
import { clientIp, getFoodDetail, withRetryAfter } from "@/lib/server/catalog";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_SECONDS = 60;
const Id = z.coerce.number().int().positive();

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await enforceRateLimit(`foods:detail:ip:${clientIp(req)}`, 600, WINDOW_SECONDS);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`foods:detail:${userId}`, 120, WINDOW_SECONDS);
    const raw = (await ctx.params).id;
    const parsed = Id.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "bad_request", "The food id must be a positive integer.");
    return Response.json(await getFoodDetail(client, parsed.data));
  } catch (e) {
    const res = jsonError(e);
    return res.status === 429 ? withRetryAfter(res, WINDOW_SECONDS) : res;
  }
}
