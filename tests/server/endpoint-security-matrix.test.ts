/**
 * W076 (F-099): the endpoint security matrix. Every route handler under app/api and app/auth
 * defines an identity check, a body size limit (when it takes a body) and a rate limit, or sits on
 * a listed exemption with a reason. A static read, like ratelimit-call-sites.test.ts: a route
 * counts a property when its own source, or a project module it imports directly, shows it.
 *
 * - identity: a session (`requireUser`, `requireRecipeUser`), a personal access token
 *   (`withTokenUser`), a source ingest token (`resolveSourceByToken`) or the cron secret
 *   (`cronSecretOk`).
 * - body limit: only for POST, PUT, PATCH and DELETE handlers that read a body: `readJson`, a
 *   capped text/stream reader, or an explicit Content-Length / byte-length check.
 * - rate limit: `enforceRateLimit`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;

const IDENTITY = /\b(requireUser|requireRecipeUser|withTokenUser|resolveSourceByToken|cronSecretOk)\b/;
const BODY_LIMIT = /\b(readJson|readCappedText|readCappedBody|rejectDeclaredOversize|readLimited)\b|content-length|byteLength/i;
const RATE_LIMIT = /\benforceRateLimit\b/;
const READS_BODY = /\b(req|request)\.(json|text|formData|arrayBuffer|blob)\(|\.body\b|\breadJson\b|readCapped/;
const BODY_METHODS = /export (?:async )?function (POST|PUT|PATCH|DELETE)\b|export const (POST|PUT|PATCH|DELETE)\b/;

type Property = "identity" | "bodyLimit" | "rateLimit";

/** Routes that lack a property on purpose. Each reason says what stands in for it. */
const EXEMPT: Record<string, Partial<Record<Property, string>>> = {
  "app/api/health/route.ts": { identity: "Uptime monitor probe: no session, no user data, no-store; limited per IP." },
  "app/api/warm/route.ts": { identity: "Foreground warm ping: no read and no write; limited per IP." },
  "app/api/auth/otp/route.ts": { identity: "Sign-in is how a session starts; limited by lib/server/sign-in.ts (10 per 10 min per IP)." },
  "app/api/auth/password/route.ts": { identity: "Sign-in is how a session starts; limited by lib/server/sign-in.ts (10 per 10 min per IP)." },
  "app/api/auth/verify/route.ts": { identity: "Sign-in is how a session starts; limited by lib/server/sign-in.ts (10 per 10 min per IP)." },
  "app/api/dev/sign-in/route.ts": {
    identity: "Local development only: answers 404 in production and on any Vercel environment.",
    rateLimit: "Local development only: answers 404 in production and on any Vercel environment.",
  },
  "app/api/onboarding/profile-pilot/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/rebalance/access/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/recipes/access/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/account/delete/enabled/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/profile/taste/enabled/route.ts": { rateLimit: "A boolean flag read behind the session; one environment-variable check, no database read, so no limiter." },
  "app/api/foods/world/invitation/route.ts": { rateLimit: "A short per-account read behind the session; no model call, no fan-out." },
  "app/api/recipes/[id]/route.ts": { rateLimit: "One recipe read by primary key behind the session and the recipe pilot gate; no model call." },
  "app/api/recipes/favorites/route.ts": { rateLimit: "The caller's own favourites list behind the session and the pilot gate; no model call." },
  "app/api/recipes/[id]/favorite/route.ts": { rateLimit: "Session-scoped write of one row the caller owns (RLS); bounded body, no model or fan-out, so no per-route limiter yet." },
  "app/api/shopping/pantry/[id]/route.ts": { rateLimit: "Session-scoped write of one row the caller owns (RLS); bounded body, no model or fan-out, so no per-route limiter yet." },
  "app/api/shopping/periods/[id]/purchase-windows/[windowId]/route.ts": { rateLimit: "Session-scoped write of one row the caller owns (RLS); bounded body, no model or fan-out, so no per-route limiter yet." },
};

function routeFiles(): string[] {
  return ["app/api", "app/auth"].flatMap((dir) =>
    (readdirSync(path.join(ROOT, dir), { recursive: true }) as string[])
      .filter((f) => /(^|\/)route\.ts$/.test(f)).map((f) => path.join(dir, f)));
}

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** The route's own source plus every project module it imports directly. */
function visibleSource(file: string): { own: string; all: string } {
  const abs = path.join(ROOT, file);
  const own = readFileSync(abs, "utf8");
  const parts = [own];
  for (const m of own.matchAll(IMPORT)) {
    const next = resolve(abs, m[1]);
    if (next && !next.endsWith(".test.ts")) parts.push(readFileSync(next, "utf8"));
  }
  return { own, all: parts.join("\n") };
}

function gaps(file: string): Property[] {
  const { own, all } = visibleSource(file);
  const missing: Property[] = [];
  if (!IDENTITY.test(all)) missing.push("identity");
  if (BODY_METHODS.test(own) && READS_BODY.test(all) && !BODY_LIMIT.test(all)) missing.push("bodyLimit");
  if (!RATE_LIMIT.test(all)) missing.push("rateLimit");
  return missing;
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

  it("flags a route with none of the three (the matrix can fail)", () => {
    const probe = "export async function POST(req: Request) { return Response.json(await req.json()); }";
    expect(IDENTITY.test(probe)).toBe(false);
    expect(RATE_LIMIT.test(probe)).toBe(false);
    expect(BODY_METHODS.test(probe) && READS_BODY.test(probe) && !BODY_LIMIT.test(probe)).toBe(true);
  });
});
