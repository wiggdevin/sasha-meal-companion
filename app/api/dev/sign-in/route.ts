import { devSignInAllowed } from "@/lib/server/dev-sign-in";
/**
 * GET /api/dev/sign-in — local development only.
 *
 * Signs the browser in as DEV_SIGN_IN_EMAIL without an email round trip, so the app can be
 * clicked through on a dev server while Supabase's built-in mailer (2 emails/hour/project) is
 * rate-limited or unavailable. It never runs in production: NODE_ENV=production, any Vercel
 * environment, or an unset DEV_SIGN_IN_EMAIL all answer 404 before anything else happens.
 *
 * It uses the same cookie path as the magic-link callback: the request-local client verifies a
 * server-generated one-time token, and applyCookies emits the session cookie.
 */

import { adminClient } from "@/lib/server/admin";
import { applyCookies, createRequestClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export async function GET(req: Request): Promise<Response> {
  if (!devSignInAllowed()) return notFound();
  const email = process.env.DEV_SIGN_IN_EMAIL as string;
  // lib/server/admin.ts is the only file that may read the service-role key (Phase 0 guard test).
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) {
    return new Response("dev sign-in: could not generate a link", { status: 500 });
  }

  const client = createRequestClient(req);
  const verified = await client.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: "magiclink",
  });
  if (verified.error) {
    return new Response(`dev sign-in: ${verified.error.message}`, { status: 500 });
  }

  // Response.redirect() returns immutable headers, so applyCookies could not add the cookie.
  const location = new URL("/", new URL(req.url).origin).toString();
  return applyCookies(req, new Response(null, { status: 303, headers: { location } }));
}
