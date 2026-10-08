/**
 * Refreshes the Supabase session cookie on every page request and sends an
 * unauthenticated one to /sign-in (spec "Supporting server modules").
 *
 * The matcher keeps this away from /api/*, /auth/*, /_next/* and any path with
 * a file extension. /sign-in is excluded too, or a signed-out visitor would
 * loop on the redirect.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export const config = {
  matcher: ["/((?!api/|auth/|_next/|sign-in|.*\\.[^/]+$).*)"],
};

export default async function middleware(req: NextRequest): Promise<NextResponse> {
  let res = NextResponse.next({ request: req });
  // The /design galleries render static fixtures and answer 404 in production (app/design).
  if (process.env.NODE_ENV !== "production"
    && (req.nextUrl.pathname === "/design" || req.nextUrl.pathname.startsWith("/design/"))) return res;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return res;

  const supabase = createServerClient(url, key, {
    // @supabase/ssr's own default omits `secure` entirely, so without this the
    // session cookie's Set-Cookie never carries Secure and would still be
    // sent over a plain-HTTP request.
    cookieOptions: { secure: true, sameSite: "lax" },
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookies, headers) => {
        for (const cookie of cookies) req.cookies.set(cookie.name, cookie.value);
        res = NextResponse.next({ request: req });
        for (const cookie of cookies) res.cookies.set(cookie.name, cookie.value, cookie.options);
        // Cache-Control/Expires/Pragma @supabase/ssr asks to be set alongside
        // the cookie, so a CDN or reverse proxy never caches one user's
        // refreshed session cookie and serves it to a different user (see
        // lib/supabase/server.ts's applyCookies for the same invariant).
        for (const [k, v] of Object.entries(headers ?? {})) res.headers.set(k, v);
      },
    },
  });

  try {
    const { data } = await supabase.auth.getClaims();
    if (typeof data?.claims?.sub !== "string") {
      const to = req.nextUrl.clone();
      to.pathname = "/sign-in";
      to.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
      return NextResponse.redirect(to);
    }
    return res;
  } catch {
    // A transient auth-service failure (network/DNS/JWKS fetch) degrades to
    // an unauthenticated redirect instead of an uncaught site-wide 500.
    const to = req.nextUrl.clone();
    to.pathname = "/sign-in";
    to.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(to);
  }
}
