/**
 * W055 (B106, Phase 9 §0.5a "Later"): `x-smc-account` is checked on EVERY cookie-authenticated
 * route. An inventory of `app/api/**\/route.ts`: every exported handler is run twice under B's
 * session, once with no header and once with A's header, against Supabase clients that throw on
 * any query. Each must refuse (401 `account_header_required`, 409 `account_mismatch`) before it
 * reads or writes anything — so a wrong-account header never returns the other account's data.
 *
 * A route that does not use the session cookie is allowed only with a reason in NOT_COOKIE below.
 * A new route that skips `requireUser` fails here until it is fixed or listed with its reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOT = process.cwd();

const queries: string[] = [];
const getClaims = vi.fn();
/** Any table, RPC or storage use is a read or write that ran before the account check. */
function noQueryClient(label: string) {
  const refuse = (what: string) => () => {
    queries.push(`${label}.${what}`);
    throw new Error(`${label}.${what}: no query may run before the account check`);
  };
  return {
    auth: { getClaims, admin: new Proxy({}, { get: (_t, k) => refuse(`auth.admin.${String(k)}`) }) },
    from: refuse("from"), rpc: refuse("rpc"), schema: refuse("schema"),
    storage: { from: refuse("storage.from") },
  };
}

vi.mock("@/lib/supabase/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createRequestClient: () => noQueryClient("session"),
}));
vi.mock("@/lib/server/admin", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adminClient: () => noQueryClient("admin"),
}));

/** Routes that never read the session cookie, each with the identity it uses instead. */
const NOT_COOKIE: Record<string, string> = {
  "app/api/auth/otp/route.ts": "sign-in (W052): no session yet; IP-limited before Supabase Auth",
  "app/api/auth/password/route.ts": "sign-in (W052): no session yet; IP-limited before Supabase Auth",
  "app/api/auth/verify/route.ts": "sign-in (W052): creates the session; IP-limited before Supabase Auth",
  "app/api/client-errors/route.ts": "crash reports (W053): no session, no table; IP-limited, credentials omitted",
  "app/api/dev/sign-in/route.ts": "dev-only sign-in: creates the session, refused outside local dev",
  "app/api/health/route.ts": "uptime probe: no session, no user data",
  "app/api/health/ingest/route.ts": "per-source bearer token (health-tokens), not the cookie",
  "app/api/health/oura/callback/route.ts": "OAuth redirect: identity from the bound oauth_states row",
  "app/api/mcp/route.ts": "per-user personal access token (bearer), not the cookie",
  "app/api/warm/route.ts": "foreground warm ping: no session, no database read",
  "app/api/jobs/backup/route.ts": "cron: CRON_SECRET bearer",
  "app/api/jobs/estimate/route.ts": "cron: CRON_SECRET bearer",
  "app/api/jobs/facet-warm/route.ts": "cron: CRON_SECRET bearer",
  "app/api/jobs/media-sweep/route.ts": "cron: CRON_SECRET bearer",
  "app/api/jobs/onboarding-events-purge/route.ts": "cron: CRON_SECRET bearer",
  "app/api/jobs/oura-pull/route.ts": "cron: CRON_SECRET bearer",
  "app/api/jobs/signal-purge/route.ts": "cron: CRON_SECRET bearer",
  "app/api/jobs/spend-sweep/route.ts": "cron: CRON_SECRET bearer",
  "app/api/jobs/weekly-proposal/route.ts": "cron: CRON_SECRET bearer",
  "app/api/jobs/weekly-review/route.ts": "cron: CRON_SECRET bearer",
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const routeFiles = (readdirSync(path.join(ROOT, "app/api"), { recursive: true }) as string[])
  .filter((f) => /(^|\/)route\.ts$/.test(f)).map((f) => path.join("app/api", f)).sort();

/** Every exported HTTP handler, read from the source so a new export is never skipped. */
const handlers = routeFiles.flatMap((file) => {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  return METHODS.filter((m) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`).test(src)
    || new RegExp(`export\\s*\\{[^}]*\\b${m}\\b[^}]*\\}`).test(src))
    .map((method) => ({ file, method }));
});
const cookieHandlers = handlers.filter((h) => !(h.file in NOT_COOKIE));

/** Dynamic segments get a uuid, so a handler that validates its params still reaches its auth. */
const context = { params: Promise.resolve(new Proxy({}, { get: () => A })) };

async function call(file: string, method: string, headers: Record<string, string>): Promise<Response> {
  const mod = await import(/* @vite-ignore */ path.join(ROOT, file)) as Record<string, unknown>;
  const handler = mod[method] as (req: Request, ctx: unknown) => Promise<Response>;
  const url = `https://app.test/${file.replace(/^app\//, "").replace(/\/route\.ts$/, "")}?date=2026-10-11`;
  const init: RequestInit = { method, headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", ...headers } };
  if (method !== "GET") init.body = "{}";
  return handler(new Request(url, init), context);
}

/** Feature switches on, so a flag-gated route reaches its account check instead of its 404/503. */
const FLAGS = { COACH_ENABLED: "1", HEALTH_INGEST_ENABLED: "1", FEATURE_SCAN: "1",
  TASTE_CHIPS_ENABLED: "1", RECIPE_PLANNING_USER_IDS: "*", CONDITION_PACKS_ENABLED: "1",
  ACCOUNT_DELETION_ENABLED: "1" };

beforeEach(() => {
  for (const [k, v] of Object.entries(FLAGS)) vi.stubEnv(k, v);
  queries.length = 0;
  getClaims.mockReset();
  getClaims.mockResolvedValue({ data: { claims: { sub: B } }, error: null });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("route inventory (W055)", () => {
  it("finds every route and every exported handler", () => {
    expect(routeFiles.length).toBeGreaterThan(100);
    expect(cookieHandlers.length).toBeGreaterThan(100);
    // Every route exports at least one handler the scan can see.
    for (const file of routeFiles) expect(handlers.some((h) => h.file === file), file).toBe(true);
  });

  it("every allowlisted route exists and carries a reason", () => {
    for (const [file, reason] of Object.entries(NOT_COOKIE)) {
      expect(routeFiles, file).toContain(file);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("an allowlisted route never reads the session cookie through requireUser", () => {
    for (const file of Object.keys(NOT_COOKIE)) {
      expect(readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(/require(?:Recipe)?User\(/);
    }
  });
});

describe("every cookie route checks x-smc-account before any query (W055)", () => {
  it.each(cookieHandlers.map((h) => [`${h.method} ${h.file}`, h] as const))(
    "%s: no header → 401 account_header_required, nothing read",
    { timeout: 30_000 },
    async (_name, { file, method }) => {
      const res = await call(file, method, {});
      expect(queries).toEqual([]);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: "account_header_required" });
    },
  );

  it.each(cookieHandlers.map((h) => [`${h.method} ${h.file}`, h] as const))(
    "%s: another account's header → 409 account_mismatch, nothing read",
    { timeout: 30_000 },
    async (_name, { file, method }) => {
      const res = await call(file, method, { "x-smc-account": A });
      expect(queries).toEqual([]);
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: "account_mismatch" });
    },
  );
});
