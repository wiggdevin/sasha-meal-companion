/**
 * GET /api/health/oura/callback — spec §5. No JWT is assumed: identity comes from the oauth_states
 * row. The provider's own error text is never echoed; every failure maps to a fixed reason code
 * (spec §8) and the browser returns to the same-origin path encoded in the bound state.
 */
import { randomUUID } from "node:crypto";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { completeOura, pullTwoDays } from "@/lib/server/oura";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { oauthReturnTo } from "@/lib/health/oura-return";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(origin: string, state: string | null, reason?: string): Response {
  const url = new URL(oauthReturnTo(state, origin), origin);
  url.searchParams.set("oura", reason ? "error" : "connected");
  if (reason) url.searchParams.set("reason", reason);
  return Response.redirect(url, 302);
}

/**
 * `x-real-ip` is the address Vercel's edge network actually accepted the
 * connection from (it overwrites any client-supplied value), so it can be
 * trusted; `x-forwarded-for` cannot (see app/auth/callback/route.ts). A caller
 * with no resolvable IP gets its own key rather than sharing one bucket that a
 * single caller could exhaust for everybody else — including the same account's
 * real Oura redirect.
 */
function rateLimitKey(req: Request): string {
  const ip = req.headers.get("x-real-ip");
  return ip ? `health:oura:callback:${ip}` : `health:oura:callback:anon:${randomUUID()}`;
}

export async function GET(req: Request): Promise<Response> {
  const { origin, searchParams } = new URL(req.url);
  const state = searchParams.get("state");
  try {
    if (!process.env.HEALTH_INGEST_ENABLED) return back(origin, state, "disabled");
    await enforceRateLimit(rateLimitKey(req), 20, 3600);
    if (searchParams.get("error")) return back(origin, state, "denied");

    const code = searchParams.get("code");
    if (!state || !code) return back(origin, state, "bad_state");

    const admin = adminClient();
    const { sourceId, userId } = await completeOura(admin, { state, code });

    // One immediate pull so Settings shows a "last received" marker after the redirect.
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await admin.from("health_sources")
      .select("id, user_id, oauth").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    if (data) {
      try {
        await pullTwoDays(admin, data as { id: string; user_id: string; oauth: string | null }, today);
      } catch {
        // A first pull that fails is not a failed connection; the cron retries at 06:00.
      }
    }
    return back(origin, state);
  } catch (e) {
    const reason = e instanceof HttpError ? e.code : "internal";
    return back(origin, state, reason);
  }
}
