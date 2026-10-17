import { z } from "zod";
import { PREP_STATES } from "@/lib/search/query";
import { HttpError, requireUser } from "@/lib/server/auth";
import { clientIp, searchFoods, withRetryAfter } from "@/lib/server/catalog";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// T0 §5: fluid-compute function config. The region is pinned to the Supabase project's own
// (us-west-1 -> sfo1, as vercel.json "regions") so every query in this route is a short hop,
// and `maxDuration` is the client budget in lib/fetch-with-deadline.ts plus room for the
// response, never more.
export const preferredRegion = ["sfo1"];
export const maxDuration = 15;

const MAX_URL_BYTES = 8 * 1024;
const WINDOW_SECONDS = 60;

const Query = z.object({
  q: z.string().trim().min(1).max(120),
  brand: z.string().trim().min(1).max(120).optional(),
  prep: z.enum(PREP_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(25).default(25),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`foods:search:ip:${clientIp(req)}`, 600, WINDOW_SECONDS);
    if (Buffer.byteLength(req.url, "utf8") > MAX_URL_BYTES) {
      throw new HttpError(413, "too_large", `Request over ${MAX_URL_BYTES} bytes.`);
    }
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`foods:search:${userId}`, 120, WINDOW_SECONDS);
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const parsed = Query.safeParse(params);
    if (!parsed.success) {
      throw new HttpError(400, "bad_request", "Check q, brand, prep and limit.");
    }
    const body = await searchFoods(client, parsed.data);
    return Response.json(body);
  } catch (e) {
    const res = jsonError(e);
    return res.status === 429 ? withRetryAfter(res, WINDOW_SECONDS) : res;
  }
}
