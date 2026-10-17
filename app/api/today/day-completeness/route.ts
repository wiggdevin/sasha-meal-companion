import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { judgeDayCompleteness } from "@/lib/server/day-completeness";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hour = z.number().int().min(0).max(23);
const Body = z.object({
  isToday: z.boolean(),
  localHour: hour.nullable(),
  mealsEaten: z.number().int().min(0).max(12),
  entryCount: z.number().int().min(0).max(100),
  lastEntryHour: hour.nullable(),
}).strict();

/**
 * POST /api/today/day-completeness — W142. Counts and hours of the viewed day in, `{ nudge }` out:
 * true only when Jev is above its threshold that a meal went unrecorded. No names, notes or health
 * fields are accepted. Advisory: any failure answers `{ nudge: false }` and the mark is never held.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    await enforceRateLimit(`today:day-completeness:${userId}`, 30, 60);
    const state = await readJson(req, Body, 512);
    const nudge = await judgeDayCompleteness(state, userId);
    return Response.json({ nudge }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
