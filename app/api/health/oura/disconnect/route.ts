/** POST /api/health/oura/disconnect — spec §5: revoke and null the tokens; samples stay. */
import { adminClient } from "@/lib/server/admin";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    await enforceRateLimit(`health:oura:disconnect:${userId}`, 20, 3600);
    const { data, error } = await adminClient().from("health_sources")
      .update({ revoked_at: new Date().toISOString(), oauth: null })
      .eq("user_id", userId).eq("kind", "oura").select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "not_found", "No Oura source.");
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
