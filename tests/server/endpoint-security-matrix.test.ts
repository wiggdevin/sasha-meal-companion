/**
 * W076 (F-099): the endpoint security matrix. Every route handler under app/api and app/auth
 * defines an identity check, a body size limit (when it takes a body) and a rate limit, or sits on
 * a listed exemption with a reason. A static read, like ratelimit-call-sites.test.ts: a route
 * counts a property only when its own source (comments removed) calls the check.
 *
 * - identity: a session (`requireUser`, `requireRecipeUser`), a personal access token
 *   (`withTokenUser`), a source ingest token (`resolveSourceByToken`) or the cron secret
 *   (`cronSecretOk`).
 * - body limit: only for POST, PUT, PATCH and DELETE handlers that read a body: `readJson`, a
 *   capped text/stream reader, or an explicit Content-Length / byte-length check.
 * - rate limit: `enforceRateLimit`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

// Calls only, in the route's own source with comments removed: importing a module that merely
// defines or mentions a check proves nothing.
const IDENTITY = /\b(requireUser|requireRecipeUser|withTokenUser|resolveSourceByToken|cronSecretOk|bearerOk)\s*\(/;
const BODY_LIMIT = /\b(readJson|readCappedText|readCappedBody|rejectDeclaredOversize|readLimited)\s*\(|content-length|byteLength/i;
const RATE_LIMIT = /\benforceRateLimit\s*\(/;
const READS_BODY = /\b(req|request)\.(json|text|formData|arrayBuffer|blob)\s*\(|\b(req|request)\.body\b|\breadJson\s*\(|readCapped/;
const BODY_METHODS = /export (?:async )?function (POST|PUT|PATCH|DELETE)\b|export const (POST|PUT|PATCH|DELETE)\b|export \{[^}]*\bas (POST|PUT|PATCH|DELETE)\b/;

type Property = "identity" | "bodyLimit" | "rateLimit";

/** Routes that lack a property on purpose. Each reason says what stands in for it. */
const EXEMPT: Record<string, Partial<Record<Property, string>>> = {
  "app/api/health/route.ts": { identity: "Uptime monitor probe: no session, no user data, no-store; limited per IP." },
  "app/api/warm/route.ts": { identity: "Foreground warm ping: no read and no write; limited per IP." },
  "app/api/auth/otp/route.ts": {
    identity: "Sign-in is how a session starts; no session exists yet.",
    rateLimit: "Limited through lib/server/sign-in.ts (signInLimitKey, 10 per 10 min per IP), not called in the route itself.",
  },
  "app/api/auth/password/route.ts": {
    identity: "Sign-in is how a session starts; no session exists yet.",
    rateLimit: "Limited through lib/server/sign-in.ts (signInLimitKey, 10 per 10 min per IP), not called in the route itself.",
  },
  "app/api/auth/verify/route.ts": {
    identity: "Sign-in is how a session starts; no session exists yet.",
    rateLimit: "Limited through lib/server/sign-in.ts (signInLimitKey, 10 per 10 min per IP), not called in the route itself.",
  },
  "app/api/dev/sign-in/route.ts": {
    identity: "Local development only: answers 404 in production and on any Vercel environment.",
    rateLimit: "Local development only: answers 404 in production and on any Vercel environment.",
  },
  "app/api/onboarding/profile-pilot/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/rebalance/access/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/recipes/access/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/account/delete/enabled/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/profile/taste/enabled/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/client-errors/route.ts": { identity: "Crash reports from a signed-out page too; allowlisted fields only, 4 KB cap, 30 per minute per IP." },
  "app/api/health/oura/callback/route.ts": { identity: "Oura redirects the browser here without a session; identity is the single-use oauth_states row bound to the state, and the call is limited per IP." },
  "app/auth/callback/route.ts": { identity: "Magic-link landing: the one-time code in the URL is the credential, exchanged for a session; limited per IP." },
  "app/api/health/oura/start/route.ts": { bodyLimit: "Known gap: behind the session and limited to 10 per hour, but the returnTo body is read with req.text() and no size cap. Follow-up to switch it to readJson." },
  "app/api/foods/world/invitation/route.ts": { rateLimit: "A short per-account read behind the session; no model call, no fan-out." },
  "app/api/recipes/[id]/route.ts": { rateLimit: "One recipe read by primary key behind the session and the recipe pilot gate; no model call." },
  "app/api/recipes/favorites/route.ts": { rateLimit: "The caller's own favourites list behind the session and the pilot gate; no model call." },
  "app/api/recipes/[id]/favorite/route.ts": { rateLimit: "Known gap, not an offset: a session-scoped write of one row the caller owns (RLS) with a capped body (readJson, 1 KB) and no model call, but no per-route limiter. Follow-up." },
  "app/api/shopping/pantry/[id]/route.ts": { rateLimit: "Known gap, not an offset: a session-scoped write of one row the caller owns (RLS) with a capped body (readJson, 1 KB) and no model call, but no per-route limiter. Follow-up." },
  "app/api/shopping/periods/[id]/purchase-windows/[windowId]/route.ts": { rateLimit: "Known gap, not an offset: a session-scoped write of one row the caller owns (RLS) with a capped body (readJson, 1 KB) and no model call, but no per-route limiter. Follow-up." },
};

function routeFiles(): string[] {
  return ["app/api", "app/auth"].flatMap((dir) =>
    (readdirSync(path.join(ROOT, dir), { recursive: true }) as string[])
      .filter((f) => /(^|\/)route\.ts$/.test(f)).map((f) => path.join(dir, f)));
}

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function gapsOf(source: string): Property[] {
  const own = stripComments(source);
  const missing: Property[] = [];
  if (!IDENTITY.test(own)) missing.push("identity");
  if (BODY_METHODS.test(own) && READS_BODY.test(own) && !BODY_LIMIT.test(own)) missing.push("bodyLimit");
  if (!RATE_LIMIT.test(own)) missing.push("rateLimit");
  return missing;
}

function gaps(file: string): Property[] {
  return gapsOf(readFileSync(path.join(ROOT, file), "utf8"));
}

describe("endpoint security matrix (W076)", () => {
  const files = routeFiles();

  it("finds the routes", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("every route has identity, a body limit and a rate limit, or a listed exemption", () => {
    const failures = files.flatMap((file) => gaps(file)
      .filter((p) => !EXEMPT[file]?.[p]).map((p) => `${file}: no ${p}`));
    expect(failures).toEqual([]);
  });

  it("lists no exemption that is unneeded, unknown or unexplained", () => {
    const stale: string[] = [];
    for (const [file, props] of Object.entries(EXEMPT)) {
      if (!files.includes(file)) { stale.push(`${file}: no such route`); continue; }
      const missing = gaps(file);
      for (const [prop, reason] of Object.entries(props)) {
        if (!reason || reason.trim().length < 20) stale.push(`${file}: ${prop} needs a reason`);
        if (!missing.includes(prop as Property)) stale.push(`${file}: ${prop} is no longer missing`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("flags what a route only imports or mentions (the matrix can fail)", () => {
    const bare = "export async function POST(req: Request) { return Response.json(await req.json()); }";
    expect(gapsOf(bare)).toEqual(["identity", "bodyLimit", "rateLimit"]);
    const importOnly = `import { HttpError, requireUser } from "@/lib/server/auth";
      import { enforceRateLimit } from "@/lib/server/ratelimit";
      // requireUser(req); enforceRateLimit(k, 1, 1); readJson(req, S, 10)
      export async function POST(req: Request) { return Response.json(await req.json()); }`;
    expect(gapsOf(importOnly)).toEqual(["identity", "bodyLimit", "rateLimit"]);
    const ok = `export async function POST(req: Request) { await requireUser(req);
      await enforceRateLimit("k", 1, 1); return Response.json(await readJson(req, S, 10)); }`;
    expect(gapsOf(ok)).toEqual([]);
  });
});
