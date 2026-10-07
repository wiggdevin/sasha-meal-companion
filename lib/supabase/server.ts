/**
 * The browser path's server client (architecture.md §2.1).
 *
 * One client per request, built from the publishable key and the caller's
 * cookies. A module-level cache would leak one user's JWT into another user's
 * request, so there is none. Cookies the client wants to write land in a
 * per-request jar; the route copies them onto its response with applyCookies.
 */

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

const JARS = new WeakMap<Request, CookieToSet[]>();

// Headers @supabase/ssr asks to be set alongside a cookie write (Cache-Control /
// Expires / Pragma), so a CDN or reverse proxy never caches one user's session
// cookie and serves it to a different user. Keyed on the request, same as JARS.
const HEADER_JARS = new WeakMap<Request, Record<string, string>>();

/** Parse a `Cookie:` header into the name/value pairs @supabase/ssr reads. */
export function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return { name: part, value: "" };
      const raw = part.slice(eq + 1).trim();
      let value = raw;
      try {
        value = decodeURIComponent(raw);
      } catch {
        // Malformed percent-encoding in an attacker-controlled Cookie header;
        // keep the raw value instead of throwing.
      }
      return { name: part.slice(0, eq).trim(), value };
    });
}

/** Render one jar entry as a `Set-Cookie` value. */
export function serializeCookie(cookie: CookieToSet): string {
  const o = (cookie.options ?? {}) as {
    path?: string;
    domain?: string;
    maxAge?: number;
    expires?: Date | string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  };
  const parts = [`${cookie.name}=${encodeURIComponent(cookie.value)}`];
  parts.push(`Path=${o.path ?? "/"}`);
  if (o.domain) parts.push(`Domain=${o.domain}`);
  if (typeof o.maxAge === "number") parts.push(`Max-Age=${Math.floor(o.maxAge)}`);
  if (o.expires) parts.push(`Expires=${new Date(o.expires).toUTCString()}`);
  if (o.httpOnly) parts.push("HttpOnly");
  if (o.secure) parts.push("Secure");
  if (o.sameSite) {
    const s = String(o.sameSite);
    parts.push(`SameSite=${s.charAt(0).toUpperCase()}${s.slice(1)}`);
  }
  return parts.join("; ");
}

/**
 * Queue cookies for the response of this request. `headers` are the
 * Cache-Control/Expires/Pragma headers @supabase/ssr's setAll passes
 * alongside a cookie write; recorded here so applyCookies can set them too.
 */
export function recordCookies(
  req: Request,
  cookies: CookieToSet[],
  headers?: Record<string, string>,
): void {
  const jar = JARS.get(req) ?? [];
  jar.push(...cookies);
  JARS.set(req, jar);
  if (headers && Object.keys(headers).length > 0) {
    HEADER_JARS.set(req, { ...HEADER_JARS.get(req), ...headers });
  }
}

/** Cookies the Supabase client asked to set while handling this request. */
export function cookieJar(req: Request): CookieToSet[] {
  return JARS.get(req) ?? [];
}

/**
 * Copy this request's cookie jar onto a response, plus any cache-control
 * headers @supabase/ssr asked for alongside those cookies (so a CDN or
 * reverse proxy never caches a session cookie meant for one user and serves
 * it to another). Returns the same response.
 */
export function applyCookies(req: Request, res: Response): Response {
  for (const cookie of cookieJar(req)) {
    res.headers.append("set-cookie", serializeCookie(cookie));
  }
  for (const [key, value] of Object.entries(HEADER_JARS.get(req) ?? {})) {
    res.headers.set(key, value);
  }
  return res;
}

export function createRequestClient(req: Request): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not set");
  }
  return createServerClient(url, key, {
    // @supabase/ssr's own default omits `secure` entirely, so without this the
    // session cookie's Set-Cookie never carries Secure and would still be
    // sent over a plain-HTTP request.
    cookieOptions: { secure: true, sameSite: "lax" },
    cookies: {
      getAll: () => parseCookieHeader(req.headers.get("cookie")),
      setAll: (cookies, headers) => recordCookies(req, cookies as CookieToSet[], headers),
    },
  });
}
