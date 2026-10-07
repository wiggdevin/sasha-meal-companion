/**
 * GET /api/warm — T0 §5. A no-op whose whole job is to exist.
 *
 * The PWA pings it when it comes to the foreground, so the Node function and its region are
 * already up by the time the user taps the FAB, and the first capture or coach turn of a session does
 * not pay a cold start on top of the model. It reads nothing, writes nothing and needs no session:
 * there is nothing here to protect, and a JWT check would be one more thing to be cold. It is
 * still rate limited per IP, because an unauthenticated route with no limit is an invitation.
 */

import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Supabase project's own region (us-west-1 -> sfo1), as vercel.json "regions".
export const preferredRegion = ["sfo1"];
export const maxDuration = 5;

export async function GET(req: Request): Promise<Response> {
  try {
    const ip = requestIp(req);
    await enforceRateLimit(`warm:ip:${ip}`, 120, 60, "fail_open");
  } catch (e) {
    return jsonError(e);
  }
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
