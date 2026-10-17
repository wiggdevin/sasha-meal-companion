/**
 * Refreshes the Supabase session cookie on every page request and sends an
 * unauthenticated one to /sign-in (spec "Supporting server modules").
 *
 * The matcher keeps this away from /api/*, /auth/*, /_next/* and any path with
 * a file extension. /sign-in gets the page policy below but never the auth
 * check, or a signed-out visitor would loop on the redirect.
 *
 * Every page response also carries the nonce CSP (W079, lib/security-headers.ts):
 * the nonce goes on the request's own policy header, where Next reads it and
 * stamps its scripts, and the same policy goes out on the response.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { designGalleryOpen } from "@/app/design/gallery-access";
import { NONCE_HEADER, PAGE_CSP_HEADER, makeNonce, pagePolicy } from "@/lib/security-headers";

export const config = {
  matcher: ["/((?!api/|auth/|_next/|.*\\.[^/]+$).*)"],
};

function isSignIn(pathname: string): boolean {
  return pathname === "/sign-in" || pathname.startsWith("/sign-in/");
}

export default async function middleware(req: NextRequest): Promise<NextResponse> {
  const nonce = makeNonce();
  const policy = pagePolicy(nonce, {
    dev: process.env.NODE_ENV === "development",
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  // Rebuilt from req.headers each time, so a cookie the session refresh set below rides along.
  const next = (): NextResponse => {
    const headers = new Headers(req.headers);
    headers.set(PAGE_CSP_HEADER, policy);
    headers.set(NONCE_HEADER, nonce);
    return NextResponse.next({ request: { headers } });
  };
  const withPolicy = (response: NextResponse): NextResponse => {
    response.headers.set(PAGE_CSP_HEADER, policy);
    return response;
  };

  let res = next();
  // The /design fixture galleries: local development with an explicit opt-in only (app/design/gallery-access.ts).
  if (designGalleryOpen(req.nextUrl.pathname) || isSignIn(req.nextUrl.pathname)) return withPolicy(res);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return withPolicy(res);

  const supabase = createServerClient(url, key, {
    // @supabase/ssr's own default omits `secure` entirely, so without this the
    // session cookie's Set-Cookie never carries Secure and would still be
    // sent over a plain-HTTP request.
    cookieOptions: { secure: true, sameSite: "lax" },
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookies, headers) => {
        for (const cookie of cookies) req.cookies.set(cookie.name, cookie.value);
        res = next();
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
    return withPolicy(res);
  } catch {
    // A transient auth-service failure (network/DNS/JWKS fetch) degrades to
    // an unauthenticated redirect instead of an uncaught site-wide 500.
    const to = req.nextUrl.clone();
    to.pathname = "/sign-in";
    to.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(to);
  }
}
