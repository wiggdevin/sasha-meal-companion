/**
 * The magic-link landing (spec "API changes"). Exchanges the code for a
 * session, writes the session cookies onto the redirect, and only ever sends
 * the browser to a same-origin path.
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "@/lib/server/auth";
import { jsonError, safeNextPath } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { applyCookies, createRequestClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirect(to: URL): Response {
  return new Response(null, { status: 302, headers: { location: to.toString() } });
}

/**
 * Vercel's edge network sets `x-real-ip` to the address it actually accepted
 * the connection from and overwrites any client-supplied value, so it can be
 * trusted. `x-forwarded-for` cannot: a caller can set it to anything, so
 * keying the limiter on it lets an attacker rotate past `enforceRateLimit`
 * entirely. When neither header resolves an IP (local dev, tests), give the
 * request its own key instead of grouping every such caller into one shared
 * bucket that one heavy caller could exhaust for everybody else.
 */
function rateLimitKey(req: Request): string {
  const ip = req.headers.get("x-real-ip");
  return ip ? `auth:callback:${ip}` : `auth:callback:anon:${randomUUID()}`;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    await enforceRateLimit(rateLimitKey(req), 20, 60);

    const code = url.searchParams.get("code");
    if (!code) {
      return redirect(new URL("/sign-in?error=missing_code", url.origin));
    }

    const next = safeNextPath(url.searchParams.get("next"));
    const client = createRequestClient(req);
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) {
      return redirect(new URL("/sign-in?error=exchange_failed", url.origin));
    }

    return applyCookies(req, redirect(new URL(next, url.origin)));
  } catch (e) {
    // A landed top-level browser navigation (the user tapped the emailed link), so
    // a rate-limit trip must land them back on /sign-in, not a bare JSON body.
    if (e instanceof HttpError && e.code === "rate_limited") {
      return redirect(new URL("/sign-in?error=rate_limited", url.origin));
    }
    return jsonError(e);
  }
}
