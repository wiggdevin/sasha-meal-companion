/** GET /api/expenditure — JWT, read-only, 60/min/user (spec "Security"). RLS does the scoping. */
import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { latestEstimate, weightTrendSeries } from "@/lib/server/expenditure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const ip = requestIp(req);
    await enforceRateLimit(`expenditure:ip:${ip}`, 60, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`expenditure:user:${userId}`, 60, 60);
    // Design §8.2: `/body` draws its weight-trend line from stored rows, so the body response
    // carries the dated series alongside the current result. Both reads are user-scoped.
    const [estimate, weightTrendSeriesKg] = await Promise.all([
      latestEstimate(client, userId), weightTrendSeries(client, userId),
    ]);
    return Response.json({ ...estimate, weightTrendSeriesKg });
  } catch (e) {
    return jsonError(e);
  }
}
