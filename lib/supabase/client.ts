"use client";

/**
 * The browser-side Supabase client, used by the sign-in screen and AuthGate.
 * createBrowserClient keeps its own singleton inside @supabase/ssr, so this
 * module holds no client of its own.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/** `fetch` is a caller-supplied transport (a test double, or a request carrying a timeout). */
export function browserClient(opts: { fetch?: typeof fetch } = {}): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not set");
  }
  // @supabase/ssr's own default omits `secure` entirely, so without this the
  // session cookie's Set-Cookie never carries Secure and would still be sent
  // over a plain-HTTP request.
  return createBrowserClient(url, key, {
    cookieOptions: { secure: true, sameSite: "lax" },
    ...(opts.fetch ? { global: { fetch: opts.fetch } } : {}),
  });
}

/**
 * The browser-side copy of the rule safeNextPath applies in lib/server/http.ts:
 * a redirect target is acceptable only when it stays on this origin. Written
 * out again here on purpose, because this module ships to the browser and
 * importing anything from lib/server/ would pull the server client into that
 * bundle. Server routes still re-check for themselves.
 *
 * Control characters are rejected, not just leading "//": browsers strip tabs,
 * newlines and carriage returns out of a URL before resolving it, so
 * "/\t/evil.com" would pass a prefix-only check and then resolve as the
 * protocol-relative "//evil.com" — off this origin. That matters wherever the
 * value reaches a real navigation, which is the sign-in screen's redirect.
 */
export function safePath(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  for (let i = 0; i < next.length; i += 1) {
    if (next.charCodeAt(i) < 0x20) return "/";
  }
  return next;
}

/** Where the magic link should land. The `next` is sanitised before it is sent. */
export function callbackRedirectUrl(origin: string, next: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(safePath(next))}`;
}
