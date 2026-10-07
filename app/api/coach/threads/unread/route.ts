/**
 * GET → `{ unread: number }`: how many of this account's live threads hold an unopened weekly
 * review (#374: delivery sets `coach_threads.unread_at`; opening the thread clears it). The same
 * rule as `unread` on `GET /api/coach/threads`, read as one head/count query so a badge can poll it
 * without listing every thread. Owner RLS client plus an explicit `user_id` filter; rate limited at
 * the thread list's numbers under its own key, so a polling badge never starves the listing.
 */
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { coachEnabled } from "@/lib/capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    if (!coachEnabled()) throw new HttpError(404, "not_found", "No such route.");
    await enforceRateLimit(`coach:threads:unread:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:threads:unread:${userId}`, 60, 60);
    const { count, error } = await client.from("coach_threads")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId).is("deleted_at", null).not("unread_at", "is", null);
    if (error || typeof count !== "number") {
      throw new HttpError(500, "internal", "Could not read your unread threads.");
    }
    return Response.json({ unread: count }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return jsonError(e);
  }
}
