/** GET /api/health/daily — spec §8: JWT, RLS path, 60/min/user, window ≤ 90 days. */
import { dailyQuerySchema, MAX_DAILY_WINDOW_DAYS, type DailyHealthResponse } from "@/lib/health/contract";
import { HttpError, requireUser } from "@/lib/server/auth";
import { listSources, mergedDays } from "@/lib/server/health-daily";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    if (!process.env.HEALTH_INGEST_ENABLED) {
      throw new HttpError(503, "unavailable", "Health data is off.");
    }
    const { searchParams } = new URL(req.url);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`health:daily:${userId}`, 60, 60);

    const parsed = dailyQuerySchema.safeParse({ from: searchParams.get("from"),
      to: searchParams.get("to") });
    if (!parsed.success) throw new HttpError(400, "bad_request", "from and to must be YYYY-MM-DD.");
    const { from, to } = parsed.data;
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (span < 0) throw new HttpError(400, "bad_request", "to is before from.");
    if (span + 1 > MAX_DAILY_WINDOW_DAYS) {
      throw new HttpError(400, "bad_request", `Window over ${MAX_DAILY_WINDOW_DAYS} days.`);
    }

    const body: DailyHealthResponse = {
      days: await mergedDays(client, userId, from, to),
      sources: await listSources(client, userId),
    };
    return Response.json(body);
  } catch (e) {
    return jsonError(e);
  }
}
