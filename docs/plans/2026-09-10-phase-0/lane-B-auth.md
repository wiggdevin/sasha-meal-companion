# Lane B — Auth and the privileged server boundary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a real Supabase identity under the app — a request-local browser-path client, a
privileged token boundary for MCP, and the sign-in surface Sasha uses — without changing any
user-visible behaviour and without touching the legacy jsonb path.

**Architecture:** Two identity paths, separated by file. The **browser path** (`lib/supabase/server.ts`
→ `lib/server/auth.ts` → `middleware.ts`, `app/auth/callback/route.ts`, `app/sign-in/page.tsx`,
`components/AuthGate.tsx`) builds a fresh `createServerClient` per request with the publishable key
and the caller's cookies, and verifies identity with `getClaims()`. The **privileged path**
(`lib/server/tokens.ts` → `lib/server/admin.ts` → `lib/server/privileged.ts`) hashes an opaque bearer
token, resolves exactly one `user_id` through the `lookup_api_token` RPC, and hands that id plus the
single service-role client to a callback. `lib/server/http.ts` and `lib/server/ratelimit.ts` are the
shared edge helpers every route uses in the same order: rate limit, identity, body. The MCP route
swaps its `SASHA_MCP_TOKEN` check for that boundary and otherwise keeps every tool byte-for-byte —
the tools still read the legacy single-tenant jsonb through `lib/server/db.ts` until the cut-over.

**Tech Stack:** Next.js 16.3.4 (App Router), React 19.2.8, TypeScript 5 (strict), Tailwind 4,
pnpm 11.25.0, Node 22, vitest 5.0.0 (`environment: "node"`, `include: ["**/*.test.ts"]`),
`@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.116.0, `mcp-handler` 2.1.1, zod 4.5.4,
Supabase Postgres, Vercel.

**Spec:** `docs/specs/phase-0-foundations.md` (with `docs/architecture.md` §2.1, §2.2, §2.3, §5 as the
authority above it, and `docs/plans/2026-09-10-phase-0/00-contracts.md` §5 as the frozen interface).

## Global Constraints

Copied verbatim from `00-contracts.md` §8. Every task's requirements implicitly include this section.

- TDD per task: failing test → run → minimal code → run → commit. Conventional commits, no AI attribution lines.
- No module-level Supabase client anywhere except `lib/server/admin.ts`'s lazily-created admin client.
- `user_id` never read from a request body. Errors are `{ error, message }`, never echo the body.
- Every route: `enforceRateLimit` first, then identity, then body parse with `readJson`.
- Files < 400 lines; functions < 50 lines.
- Before opening a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`; never the full suite twice.

Lane-specific constraints:

- Branch: `feat/p0-auth`. Create or modify **only** the files in the File structure table below.
  `app/layout.tsx`, `lib/store.ts`, `lib/sync.ts`, `lib/server/db.ts`, `package.json` and
  `vitest.config.ts` belong to other lanes or to the integration branch — do not edit them.
- `lib/server/db.ts` keeps working. The MCP tools keep reading legacy jsonb through it. Only the
  authentication wrapper in `app/api/mcp/route.ts` changes.
- `SUPABASE_SERVICE_ROLE_KEY` may appear in exactly one source file: `lib/server/admin.ts`
  (spec acceptance criterion 6, asserted by a repo grep test in this lane).
- Design: the existing dark ground, `rounded-[26px]`, the `.tap` class (`min-height: 44px;
  min-width: 44px;` — `app/globals.css:149`), `.glass` for chrome, existing token names only
  (`paper`, `fog`, `graphite`, `muted`, `hairline`, `tangerine`). No new palette.

---

## File structure

| File | Responsibility |
|---|---|
| Create `lib/server/tokens.ts` | SHA-256 token hashing, `smc_` token minting, scope check, bytea encoding for PostgREST. |
| Create `lib/server/tokens.test.ts` | Unit tests for the four token functions. |
| Create `lib/supabase/server.ts` | `createRequestClient(req)` — a fresh `@supabase/ssr` server client per request, publishable key, cookies read from the request and written into a per-request jar. |
| Create `lib/supabase/server.test.ts` | Asserts two calls give two distinct clients; cookie parse / serialize / jar. |
| Create `lib/server/auth.ts` | `HttpError` and `requireUser(req)` — identity from `getClaims()`, typed 401 on failure. |
| Create `lib/server/auth.test.ts` | `requireUser` against a mocked Supabase client: valid, missing, error. |
| Create `lib/server/http.ts` | `jsonError`, `readJson` (zod + byte limit), `safeNextPath` (same-origin redirect target). |
| Create `lib/server/http.test.ts` | Error mapping, byte limits, parse failures, redirect-target rejection. |
| Create `lib/server/admin.ts` | The ONLY module that reads `SUPABASE_SERVICE_ROLE_KEY`; lazy `adminClient()`. |
| Create `lib/server/admin.test.ts` | Repo grep: exactly one source file contains the string. |
| Create `lib/server/ratelimit.ts` | `enforceRateLimit` — fixed window in an in-instance `Map`; throws `HttpError(429)`. |
| Create `lib/server/ratelimit.test.ts` | Window fills, throws, then resets on the next window. |
| Create `lib/server/privileged.ts` | `withTokenUser` — bearer → hash → `lookup_api_token` RPC via admin → 401/403 → `fn(ctx, admin)`. |
| Create `lib/server/privileged.test.ts` | Missing / unknown / revoked / expired / wrong scope / happy path, admin RPC mocked. |
| Create `middleware.ts` | Refreshes the session cookie; redirects an unauthenticated page request to `/sign-in`; never runs on `/api/*`, `/auth/*`, `/_next/*`, `/sign-in`, static files. |
| Create `middleware.test.ts` | Matcher exclusions, redirect when signed out, pass-through when signed in. |
| Create `app/auth/callback/route.ts` | `GET` — rate limit, `exchangeCodeForSession`, 302 to a same-origin `next`, session cookies on the redirect. |
| Create `app/auth/callback/route.test.ts` | 400 without a code, 302 to `next`, 302 to `/sign-in?error=` on exchange failure. |
| Create `lib/supabase/client.ts` | `browserClient()` for the sign-in screen and `AuthGate`; `callbackRedirectUrl(origin, next)`. |
| Create `lib/supabase/client.test.ts` | `callbackRedirectUrl` shapes the magic-link return URL. |
| Create `app/sign-in/page.tsx` | One email field, one button, then "check your email". Glass card on the existing ground. |
| Create `components/AuthGate.tsx` | Renders children immediately from local state, then checks the session; shows a signed-out card when there is none. |
| Modify `app/api/mcp/route.ts` | Swap the `SASHA_MCP_TOKEN` bearer check for `withTokenUser` + `enforceRateLimit` + a 64 KB body cap. Tool behaviour unchanged. |
| Create `tests/mcp/scope.test.ts` | Read tools need `read`, write tools need `log:write`, oversize body is 413, unknown token is 401. |
| Create `scripts/mint-token.ts` | Mints one token for `SASHA_USER_ID`, inserts the hash through admin, prints the raw token once. |
| Create `tests/mcp/token.test.ts` | **[needs branch]** A token for user A cannot reach user B; revoked → 401; missing scope → 403. |

---

### Task 1: Token hashing and minting

**Files:**
- Create: `lib/server/tokens.ts`
- Test: `lib/server/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const TOKEN_PREFIX = "smc_";
  export function hashToken(raw: string): Buffer;          // sha256, 32 bytes
  export function hasScope(scopes: string[], required: string): boolean;
  export function mintToken(): { raw: string; hash: Buffer };
  export function toBytea(hash: Buffer): string;           // "\\x<hex>", the PostgREST bytea literal
  ```

- [ ] **Step 1: Write the failing test**

Create `lib/server/tokens.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashToken, hasScope, mintToken, TOKEN_PREFIX, toBytea } from "./tokens";

describe("hashToken", () => {
  it("is sha256 of the raw token, 32 bytes, collision-free", () => {
    const expected = createHash("sha256").update("smc_abc", "utf8").digest();
    expect(hashToken("smc_abc").equals(expected)).toBe(true);
    expect(hashToken("smc_abc")).toHaveLength(32);
    expect(hashToken("a").equals(hashToken("b"))).toBe(false);
  });
});

describe("hasScope", () => {
  it("matches exactly, never by prefix", () => {
    expect(hasScope(["read", "log:write"], "log:write")).toBe(true);
    expect(hasScope(["read"], "log:write")).toBe(false);
    expect(hasScope(["log:write:all"], "log:write")).toBe(false);
    expect(hasScope([], "read")).toBe(false);
  });
});

describe("mintToken", () => {
  it("prefixes smc_, never repeats, and carries the matching hash", () => {
    const { raw, hash } = mintToken();
    expect(raw.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(raw.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash.equals(hashToken(raw))).toBe(true);
    expect(new Set(Array.from({ length: 50 }, () => mintToken().raw)).size).toBe(50);
  });
});

describe("toBytea", () => {
  it("renders the PostgREST hex literal", () => {
    expect(toBytea(Buffer.from([0x00, 0x0f, 0xff]))).toBe("\\x000fff");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/server/tokens.test.ts`
Expected: FAIL — `Failed to resolve import "./tokens" from "lib/server/tokens.test.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/server/tokens.ts`:

```ts
/**
 * Personal access tokens for the privileged boundary (architecture.md §2.2).
 * The raw token is shown once at creation; only the SHA-256 hash is stored.
 */

import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "smc_";

/** SHA-256 of the raw token. 32 bytes. */
export function hashToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Exact-match scope check. A longer scope string never satisfies a shorter one. */
export function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
}

/** 32 random bytes, base64url, prefixed `smc_`, with the hash to store. */
export function mintToken(): { raw: string; hash: Buffer } {
  const raw = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashToken(raw) };
}

/**
 * PostgREST sends RPC arguments as JSON, and a Buffer would serialize as
 * `{type:"Buffer",data:[…]}`. A `bytea` argument has to arrive as the hex
 * literal `\x…` instead.
 */
export function toBytea(hash: Buffer): string {
  return `\\x${hash.toString("hex")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/server/tokens.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/server/tokens.ts lib/server/tokens.test.ts
git commit -m "feat: add token hashing, minting and scope check"
```

---

### Task 2: Request-local Supabase client

**Files:**
- Create: `lib/supabase/server.ts`
- Test: `lib/supabase/server.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };
  export function parseCookieHeader(header: string | null): { name: string; value: string }[];
  export function serializeCookie(cookie: CookieToSet): string;
  export function recordCookies(req: Request, cookies: CookieToSet[]): void;
  export function cookieJar(req: Request): CookieToSet[];
  export function applyCookies(req: Request, res: Response): Response;
  export function createRequestClient(req: Request): SupabaseClient;
  ```

- [ ] **Step 1: Write the failing test**

Create `lib/supabase/server.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCookies,
  cookieJar,
  createRequestClient,
  parseCookieHeader,
  recordCookies,
  serializeCookie,
} from "./server";

describe("parseCookieHeader", () => {
  it("splits a Cookie header and decodes values", () => {
    expect(parseCookieHeader("sb-x=1; sb-y=two%20three")).toEqual([
      { name: "sb-x", value: "1" },
      { name: "sb-y", value: "two three" },
    ]);
  });

  it("is empty when there is no header", () => {
    expect(parseCookieHeader(null)).toEqual([]);
  });
});

describe("serializeCookie", () => {
  it("writes a Set-Cookie line with the options the client asked for", () => {
    const line = serializeCookie({
      name: "sb-auth",
      value: "a b",
      options: { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 3600 },
    });
    expect(line).toBe("sb-auth=a%20b; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax");
    expect(serializeCookie({ name: "a", value: "b" })).toBe("a=b; Path=/");
  });
});

describe("the per-request cookie jar", () => {
  it("copies recorded cookies onto a response, and nothing when empty", () => {
    const req = new Request("https://app.test/");
    expect(cookieJar(req)).toEqual([]);
    expect(applyCookies(req, new Response(null, { status: 200 })).headers.get("set-cookie")).toBeNull();
    recordCookies(req, [{ name: "sb-auth", value: "tok", options: { path: "/" } }]);
    const res = applyCookies(req, new Response(null, { status: 302 }));
    expect(res.headers.get("set-cookie")).toBe("sb-auth=tok; Path=/");
  });
});

describe("createRequestClient", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Spec acceptance criterion 3: no route handler holds a module-level client.
  it("returns a distinct client for every request", () => {
    const a = createRequestClient(new Request("https://app.test/a"));
    const b = createRequestClient(new Request("https://app.test/b"));
    expect(a).not.toBe(b);
    expect(a.auth).not.toBe(b.auth);
  });

  it("refuses to build without the publishable key", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect(() => createRequestClient(new Request("https://app.test/"))).toThrow(
      /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/supabase/server.test.ts`
Expected: FAIL — `Failed to resolve import "./server" from "lib/supabase/server.test.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/supabase/server.ts`:

```ts
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
      return {
        name: part.slice(0, eq).trim(),
        value: decodeURIComponent(part.slice(eq + 1).trim()),
      };
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

/** Queue cookies for the response of this request. */
export function recordCookies(req: Request, cookies: CookieToSet[]): void {
  const jar = JARS.get(req) ?? [];
  jar.push(...cookies);
  JARS.set(req, jar);
}

/** Cookies the Supabase client asked to set while handling this request. */
export function cookieJar(req: Request): CookieToSet[] {
  return JARS.get(req) ?? [];
}

/** Copy this request's cookie jar onto a response. Returns the same response. */
export function applyCookies(req: Request, res: Response): Response {
  for (const cookie of cookieJar(req)) {
    res.headers.append("set-cookie", serializeCookie(cookie));
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
    cookies: {
      getAll: () => parseCookieHeader(req.headers.get("cookie")),
      setAll: (cookies) => recordCookies(req, cookies as CookieToSet[]),
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/supabase/server.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/supabase/server.ts lib/supabase/server.test.ts
git commit -m "feat: add request-local supabase server client"
```

---

### Task 3: HttpError and requireUser

**Files:**
- Create: `lib/server/auth.ts`
- Test: `lib/server/auth.test.ts`

**Interfaces:**
- Consumes: `createRequestClient(req: Request): SupabaseClient` from `lib/supabase/server.ts` (Task 2).
- Produces:
  ```ts
  export class HttpError extends Error { constructor(public status: number, public code: string, message?: string) }
  export async function requireUser(req: Request): Promise<{ userId: string; client: SupabaseClient }>;
  ```

- [ ] **Step 1: Write the failing test**

Create `lib/server/auth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestClient } from "@/lib/supabase/server";
import { HttpError, requireUser } from "./auth";

vi.mock("@/lib/supabase/server", () => ({ createRequestClient: vi.fn() }));

const mockedCreate = vi.mocked(createRequestClient);

function clientWith(result: unknown) {
  const getClaims = vi.fn().mockResolvedValue(result);
  return { auth: { getClaims } } as never;
}

describe("HttpError", () => {
  it("carries a status and a code, and defaults the message to the code", () => {
    const e = new HttpError(403, "forbidden");
    expect(e.status).toBe(403);
    expect(e.code).toBe("forbidden");
    expect(e.message).toBe("forbidden");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("requireUser", () => {
  beforeEach(() => {
    mockedCreate.mockReset();
  });

  it("returns the claim subject and the request client", async () => {
    const client = clientWith({ data: { claims: { sub: "11111111-1111-1111-1111-111111111111" } }, error: null });
    mockedCreate.mockReturnValue(client);
    const out = await requireUser(new Request("https://app.test/api/x"));
    expect(out.userId).toBe("11111111-1111-1111-1111-111111111111");
    expect(out.client).toBe(client);
  });

  it("throws 401 when there are no claims", async () => {
    mockedCreate.mockReturnValue(clientWith({ data: null, error: null }));
    await expect(requireUser(new Request("https://app.test/api/x"))).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("throws 401 when getClaims errors", async () => {
    mockedCreate.mockReturnValue(clientWith({ data: null, error: { message: "bad jwt" } }));
    await expect(requireUser(new Request("https://app.test/api/x"))).rejects.toBeInstanceOf(HttpError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/server/auth.test.ts`
Expected: FAIL — `Failed to resolve import "./auth" from "lib/server/auth.test.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/server/auth.ts`:

```ts
/**
 * Browser-path identity (architecture.md §2.1).
 *
 * getClaims() verifies the JWT signature. getSession() only reads the cookie
 * and proves nothing, so it is never used here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createRequestClient } from "@/lib/supabase/server";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export async function requireUser(req: Request): Promise<{ userId: string; client: SupabaseClient }> {
  const client = createRequestClient(req);
  const { data, error } = await client.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || typeof userId !== "string" || userId.length === 0) {
    throw new HttpError(401, "unauthorized", "Sign in to continue.");
  }
  return { userId, client };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/server/auth.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/server/auth.ts lib/server/auth.test.ts
git commit -m "feat: add HttpError and requireUser identity helper"
```

---

### Task 4: JSON errors, body reading and the same-origin redirect target

**Files:**
- Create: `lib/server/http.ts`
- Test: `lib/server/http.test.ts`

**Interfaces:**
- Consumes: `HttpError` from `lib/server/auth.ts` (Task 3).
- Produces:
  ```ts
  export function jsonError(e: unknown): Response;
  export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes: number): Promise<T>;
  export function safeNextPath(next: string | null): string;
  ```

`safeNextPath` lives here rather than in `app/auth/callback/route.ts` because Next 16 rejects a
`route.ts` that exports anything outside the route contract.

- [ ] **Step 1: Write the failing test**

Create `lib/server/http.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError } from "./auth";
import { jsonError, readJson, safeNextPath } from "./http";

const schema = z.object({ name: z.string() });

function jsonReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/x", { method: "POST", body, headers });
}

describe("jsonError", () => {
  it("maps an HttpError to its status, code and message", async () => {
    const res = jsonError(new HttpError(403, "forbidden", "Token lacks the scope."));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "forbidden", message: "Token lacks the scope." });
  });

  it("maps anything else to a generic 500", async () => {
    const res = jsonError(new Error("connection string postgres://user:secret@host"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal", message: "Something went wrong." });
  });
});

describe("readJson", () => {
  it("returns the parsed body", async () => {
    await expect(readJson(jsonReq('{"name":"oats"}'), schema, 1024)).resolves.toEqual({ name: "oats" });
  });

  it("rejects a declared content-length over the limit before reading", async () => {
    const req = jsonReq('{"name":"oats"}', { "content-length": "99999" });
    await expect(readJson(req, schema, 1024)).rejects.toMatchObject({ status: 413, code: "too_large" });
  });

  it("rejects an actual body over the limit", async () => {
    await expect(readJson(jsonReq(`{"name":"${"x".repeat(80)}"}`), schema, 32)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("rejects a body that is not JSON", async () => {
    await expect(readJson(jsonReq("not json"), schema, 1024)).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
    });
  });

  it("rejects a body that does not match the schema, without echoing it", async () => {
    const promise = readJson(jsonReq('{"name":42,"secret":"hunter2"}'), schema, 1024);
    await expect(promise).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await promise.catch((e: HttpError) => expect(e.message).not.toContain("hunter2"));
  });
});

describe("safeNextPath", () => {
  it("keeps a root-relative path", () => {
    expect(safeNextPath("/foods?tab=eats")).toBe("/foods?tab=eats");
  });

  it("falls back to / for anything that could leave the origin", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("//evil.test/x")).toBe("/");
    expect(safeNextPath("/\\evil.test")).toBe("/");
    expect(safeNextPath("https://evil.test")).toBe("/");
    expect(safeNextPath("week")).toBe("/");
    expect(safeNextPath("/we\nek")).toBe("/");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/server/http.test.ts`
Expected: FAIL — `Failed to resolve import "./http" from "lib/server/http.test.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/server/http.ts`:

```ts
/**
 * The shared route edge. Errors are `{ error, message }` and never echo the
 * request body (architecture.md §5, spec "API changes").
 */

import type { ZodType } from "zod";
import { HttpError } from "@/lib/server/auth";

function json(status: number, body: { error: string; message: string }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonError(e: unknown): Response {
  if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message });
  return json(500, { error: "internal", message: "Something went wrong." });
}

export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes: number): Promise<T> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(413, "too_large", `Body over ${maxBytes} bytes.`);
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new HttpError(413, "too_large", `Body over ${maxBytes} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "bad_request", "Body is not JSON.");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpError(400, "bad_request", "Body does not match the expected shape.");
  }
  return result.data;
}

/**
 * A redirect target is acceptable only when it stays on this origin: a single
 * leading slash, no scheme, no control characters. Everything else becomes "/".
 */
export function safeNextPath(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  for (let i = 0; i < next.length; i += 1) {
    if (next.charCodeAt(i) < 0x20) return "/";
  }
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/server/http.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add lib/server/http.ts lib/server/http.test.ts
git commit -m "feat: add json error mapping, bounded body reader and safe next path"
```

---

### Task 5: The one service-role module

**Files:**
- Create: `lib/server/admin.ts`
- Test: `lib/server/admin.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function adminClient(): SupabaseClient;`

`lib/server/admin.ts` deliberately does **not** `import "server-only"`. That package throws the
moment it is loaded outside a React Server Component, which would break both this lane's vitest runs
and `scripts/mint-token.ts` (Task 13). The same guarantee is kept with an explicit `window` check
inside `adminClient()`.

- [ ] **Step 1: Write the failing test**

Create `lib/server/admin.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..", "..");

/**
 * Spec acceptance criterion 6: SUPABASE_SERVICE_ROLE_KEY appears in exactly one
 * source file. .env.example and the docs describe it; source must not.
 */
describe("the service-role key", () => {
  it("appears in exactly one source file", () => {
    const out = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "SUPABASE_SERVICE_ROLE_KEY",
        "--",
        "*.ts",
        "*.tsx",
        ":!*.test.ts",
        ":!.env.example",
      ],
      { cwd: REPO, encoding: "utf8" },
    );
    const files = out.split("\n").filter((line) => line.length > 0).sort();
    expect(files).toEqual(["lib/server/admin.ts"]);
  });
});
```

Note: `lib/server/db.ts` reads the key today and is deleted at cut-over, not by this lane. Until it
is gone this test fails with `["lib/server/admin.ts", "lib/server/db.ts"]`. Change the expected array
to `["lib/server/admin.ts", "lib/server/db.ts"]` and leave this comment above it:

```ts
    // lib/server/db.ts is the legacy single-tenant layer. The integration
    // branch deletes it at cut-over; drop it from this list in that commit.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/server/admin.test.ts`
Expected: FAIL — received `["lib/server/db.ts"]`, expected `["lib/server/admin.ts", "lib/server/db.ts"]`

- [ ] **Step 3: Write minimal implementation**

Create `lib/server/admin.ts`:

```ts
/**
 * The ONLY module that reads SUPABASE_SERVICE_ROLE_KEY (architecture.md §2.2
 * rule 4, spec acceptance criterion 6). Used by the privileged boundary, the
 * import worker and cron jobs — nothing else.
 *
 * The client is cached because it holds no per-request identity: it is the
 * single documented exception to "no module-level Supabase client".
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("lib/server/admin.ts is server-only and must never reach the browser bundle.");
  }
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/server/admin.test.ts`
Expected: PASS — 1 test

- [ ] **Step 5: Commit**

```bash
git add lib/server/admin.ts lib/server/admin.test.ts
git commit -m "feat: add the single service-role admin client"
```

---

### Task 6: Fixed-window rate limit

**Files:**
- Create: `lib/server/ratelimit.ts`
- Test: `lib/server/ratelimit.test.ts`

**Interfaces:**
- Consumes: `HttpError` from `lib/server/auth.ts` (Task 3).
- Produces:
  ```ts
  export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<void>;
  export function resetRateLimits(): void;   // test seam
  ```

**Decision — the Map, not the table.** The spec offers two stores. A
`rate_limits(key, window_start, count)` table written through `adminClient()` is exact across every
serverless instance, but it adds a database round trip to the front of every request. The in-instance
`Map` costs nothing, and its two weaknesses are both acceptable for one user on one plan: the real
ceiling is `limit × live instances`, and a cold start forgets the window. Phase 0 takes the Map. The
table is the documented follow-up, written up in "Open questions" below and to be revisited the day a
second user exists.

- [ ] **Step 1: Write the failing test**

Create `lib/server/ratelimit.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enforceRateLimit, resetRateLimits } from "./ratelimit";

describe("enforceRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRateLimits();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows exactly the limit inside one window", async () => {
    for (let i = 0; i < 3; i += 1) await enforceRateLimit("mcp:t1", 3, 60);
    await expect(enforceRateLimit("mcp:t1", 3, 60)).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });

  it("starts a fresh window once the old one expires", async () => {
    for (let i = 0; i < 3; i += 1) await enforceRateLimit("mcp:t1", 3, 60);
    vi.advanceTimersByTime(60_000);
    await expect(enforceRateLimit("mcp:t1", 3, 60)).resolves.toBeUndefined();
  });

  it("counts each key on its own", async () => {
    for (let i = 0; i < 3; i += 1) await enforceRateLimit("mcp:t1", 3, 60);
    await expect(enforceRateLimit("mcp:t2", 3, 60)).resolves.toBeUndefined();
  });

  it("says how long the caller must wait", async () => {
    await enforceRateLimit("mcp:t3", 1, 60);
    await expect(enforceRateLimit("mcp:t3", 1, 60)).rejects.toThrow(/60 s/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/server/ratelimit.test.ts`
Expected: FAIL — `Failed to resolve import "./ratelimit" from "lib/server/ratelimit.test.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/server/ratelimit.ts`:

```ts
/**
 * Fixed-window counter, keyed by user id or token id (spec "Supporting server
 * modules"). The window lives in this instance's memory.
 *
 * Phase 0 choice. A serverless deploy runs several instances, so the true
 * ceiling is `limit × instances`, and a cold start forgets the window. The
 * alternative — a `rate_limits(key, window_start, count)` table written through
 * adminClient() — is exact across instances but puts a database round trip in
 * front of every request. For one user the Map is enough; the table is the
 * follow-up when a second user exists.
 */

import { HttpError } from "@/lib/server/auth";

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

function sweep(now: number): void {
  if (windows.size < 1000) return;
  for (const [key, window] of windows) {
    if (now >= window.resetAt) windows.delete(key);
  }
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const now = Date.now();
  const window = windows.get(key);
  if (!window || now >= window.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    sweep(now);
    return;
  }
  window.count += 1;
  if (window.count > limit) {
    const seconds = Math.ceil((window.resetAt - now) / 1000);
    throw new HttpError(429, "rate_limited", `Too many requests. Try again in ${seconds} s.`);
  }
}

/** Forget every window. Tests only. */
export function resetRateLimits(): void {
  windows.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/server/ratelimit.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/server/ratelimit.ts lib/server/ratelimit.test.ts
git commit -m "feat: add in-instance fixed-window rate limit"
```

---

### Task 7: The privileged token boundary

**Files:**
- Create: `lib/server/privileged.ts`
- Test: `lib/server/privileged.test.ts`

**Interfaces:**
- Consumes:
  - `adminClient(): SupabaseClient` from `lib/server/admin.ts` (Task 5)
  - `HttpError` from `lib/server/auth.ts` (Task 3)
  - `hashToken`, `hasScope`, `toBytea` from `lib/server/tokens.ts` (Task 1)
  - Lane A's RPC `lookup_api_token(p_token_hash bytea) returns table (id uuid, user_id uuid, scopes text[])`
- Produces:
  ```ts
  export type TokenUser = { userId: string; tokenId: string; scopes: string[] };
  export async function withTokenUser<T>(req: Request, scope: 'read' | 'log:write',
    fn: (ctx: TokenUser, admin: SupabaseClient) => Promise<T>): Promise<T>;
  ```

- [ ] **Step 1: Write the failing test**

Create `lib/server/privileged.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminClient } from "@/lib/server/admin";
import { hashToken, toBytea } from "@/lib/server/tokens";
import { withTokenUser } from "./privileged";

vi.mock("@/lib/server/admin", () => ({ adminClient: vi.fn() }));

const rpc = vi.fn();
vi.mocked(adminClient).mockReturnValue({ rpc } as never);

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TOKEN_A = "smc_tokenA";

function req(auth?: string): Request {
  return new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("withTokenUser", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("looks the token up by hash, never by the raw value", async () => {
    rpc.mockResolvedValue({ data: [{ id: "tok-1", user_id: USER_A, scopes: ["read"] }], error: null });
    await withTokenUser(req(`Bearer ${TOKEN_A}`), "read", async () => "ok");
    expect(rpc).toHaveBeenCalledWith("lookup_api_token", {
      p_token_hash: toBytea(hashToken(TOKEN_A)),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(TOKEN_A);
  });

  it("hands the callback the token's user and the admin client", async () => {
    rpc.mockResolvedValue({
      data: [{ id: "tok-1", user_id: USER_A, scopes: ["read", "log:write"] }],
      error: null,
    });
    const fn = vi.fn().mockResolvedValue("done");
    await expect(withTokenUser(req(`Bearer ${TOKEN_A}`), "log:write", fn)).resolves.toBe("done");
    expect(fn).toHaveBeenCalledWith(
      { userId: USER_A, tokenId: "tok-1", scopes: ["read", "log:write"] },
      { rpc },
    );
  });

  it("401s without a bearer header", async () => {
    const fn = vi.fn();
    await expect(withTokenUser(req(), "read", fn)).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(fn).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("401s on a non-bearer scheme", async () => {
    await expect(withTokenUser(req("Basic abc"), "read", vi.fn())).rejects.toMatchObject({ status: 401 });
  });

  // The RPC returns no row for missing, revoked and expired alike; a row
  // without a user_id would break architecture §2.2 rule 3.
  it.each([
    ["no row", { data: [], error: null }],
    ["an RPC error", { data: null, error: { message: "boom" } }],
    ["a row with no user_id", { data: [{ id: "tok-1", user_id: null, scopes: ["read"] }], error: null }],
  ])("401s on %s, without calling the callback", async (_label, result) => {
    rpc.mockResolvedValue(result);
    const fn = vi.fn();
    await expect(withTokenUser(req(`Bearer ${TOKEN_A}`), "read", fn)).rejects.toMatchObject({ status: 401 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("403s when the token lacks the scope", async () => {
    rpc.mockResolvedValue({ data: [{ id: "tok-1", user_id: USER_A, scopes: ["read"] }], error: null });
    const fn = vi.fn();
    await expect(withTokenUser(req(`Bearer ${TOKEN_A}`), "log:write", fn)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/server/privileged.test.ts`
Expected: FAIL — `Failed to resolve import "./privileged" from "lib/server/privileged.test.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/server/privileged.ts`:

```ts
/**
 * The privileged server boundary (architecture.md §2.2). MCP tokens are opaque
 * strings, not Supabase JWTs, so they cannot produce auth.uid() and this path
 * does not claim RLS. It resolves exactly one user_id from the token row and
 * refuses to call the callback without it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { hashToken, hasScope, toBytea } from "@/lib/server/tokens";

export type TokenUser = { userId: string; tokenId: string; scopes: string[] };

type TokenRow = { id: string; user_id: string | null; scopes: string[] | null };

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function withTokenUser<T>(
  req: Request,
  scope: "read" | "log:write",
  fn: (ctx: TokenUser, admin: SupabaseClient) => Promise<T>,
): Promise<T> {
  const raw = bearer(req);
  if (!raw) throw new HttpError(401, "unauthorized", "Bearer token required.");

  const admin = adminClient();
  const { data, error } = await admin.rpc("lookup_api_token", {
    p_token_hash: toBytea(hashToken(raw)),
  });
  if (error) throw new HttpError(401, "unauthorized", "Token lookup failed.");

  const row = (Array.isArray(data) ? data[0] : data) as TokenRow | undefined;
  // lookup_api_token returns no row for unknown, revoked and expired alike.
  if (!row || typeof row.user_id !== "string" || row.user_id.length === 0) {
    throw new HttpError(401, "unauthorized", "Unknown, revoked or expired token.");
  }

  const scopes = row.scopes ?? [];
  if (!hasScope(scopes, scope)) {
    throw new HttpError(403, "forbidden", `Token lacks the "${scope}" scope.`);
  }

  return fn({ userId: row.user_id, tokenId: row.id, scopes }, admin);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/server/privileged.test.ts`
Expected: PASS — 7 tests (the `it.each` block counts as three)

- [ ] **Step 5: Commit**

```bash
git add lib/server/privileged.ts lib/server/privileged.test.ts
git commit -m "feat: add privileged token boundary with scope enforcement"
```

---

### Task 8: Session-refresh middleware

**Files:**
- Create: `middleware.ts`
- Test: `middleware.test.ts`

**Interfaces:**
- Consumes: `createServerClient` from `@supabase/ssr`.
- Produces:
  ```ts
  export const config: { matcher: string[] };
  export default async function middleware(req: NextRequest): Promise<NextResponse>;
  ```

`next/server` imports cleanly under vitest's node environment (verified), so the test drives the real
default export with `@supabase/ssr` mocked.

- [ ] **Step 1: Write the failing test**

Create `middleware.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import middleware, { config } from "./middleware";

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

const mockedCreate = vi.mocked(createServerClient);

function clientWith(sub: string | null) {
  return {
    auth: {
      getClaims: vi.fn().mockResolvedValue({
        data: sub ? { claims: { sub } } : null,
        error: null,
      }),
    },
  } as never;
}

// Proxy for Next's matcher: the pattern is a plain negative-lookahead regex.
const matcher = new RegExp(`^${config.matcher[0]}$`);

describe("the matcher", () => {
  it("covers the page routes", () => {
    for (const p of ["/", "/week", "/foods", "/settings"]) expect(matcher.test(p)).toBe(true);
  });

  it("never touches api, auth, next internals, sign-in or static files", () => {
    for (const p of [
      "/api/mcp",
      "/api/sync",
      "/auth/callback",
      "/_next/static/chunk.js",
      "/sign-in",
      "/manifest.webmanifest",
      "/ground-v1.mp4",
      "/favicon.ico",
    ]) {
      expect(matcher.test(p)).toBe(false);
    }
  });
});

describe("middleware", () => {
  beforeEach(() => {
    mockedCreate.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects a signed-out page request to /sign-in with the path to return to", async () => {
    mockedCreate.mockReturnValue(clientWith(null));
    const res = await middleware(new NextRequest(new Request("https://app.test/week?d=2026-09-10")));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://app.test/sign-in?next=%2Fweek%3Fd%3D2026-09-10",
    );
  });

  it("passes a signed-in request through", async () => {
    mockedCreate.mockReturnValue(clientWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
    const res = await middleware(new NextRequest(new Request("https://app.test/week")));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does nothing when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const res = await middleware(new NextRequest(new Request("https://app.test/week")));
    expect(res.status).toBe(200);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test middleware.test.ts`
Expected: FAIL — `Failed to resolve import "./middleware" from "middleware.test.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `middleware.ts`:

```ts
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

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return res;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookies) => {
        for (const cookie of cookies) req.cookies.set(cookie.name, cookie.value);
        res = NextResponse.next({ request: req });
        for (const cookie of cookies) res.cookies.set(cookie.name, cookie.value, cookie.options);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  if (typeof data?.claims?.sub !== "string") {
    const to = req.nextUrl.clone();
    to.pathname = "/sign-in";
    to.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(to);
  }

  return res;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test middleware.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add middleware.ts middleware.test.ts
git commit -m "feat: refresh the session cookie and gate page routes in middleware"
```

---

### Task 9: The auth callback route

**Files:**
- Create: `app/auth/callback/route.ts`
- Test: `app/auth/callback/route.test.ts`

**Interfaces:**
- Consumes: `createRequestClient`, `applyCookies`, `recordCookies` (Task 2); `safeNextPath`,
  `jsonError` (Task 4); `enforceRateLimit` (Task 6).
- Produces: `export async function GET(req: Request): Promise<Response>` — 302 on success,
  400 `{error:'bad_request'}` without a code, 302 to `/sign-in?error=…` on exchange failure.

Next 16 rejects any export from a `route.ts` outside the route contract, so `GET`, `runtime` and
`dynamic` are the only exports here.

- [ ] **Step 1: Write the failing test**

Create `app/auth/callback/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestClient, recordCookies } from "@/lib/supabase/server";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { GET } from "./route";

vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/server")>();
  return { ...actual, createRequestClient: vi.fn() };
});

const mockedCreate = vi.mocked(createRequestClient);

function clientThat(result: { error: { message: string } | null }, onExchange?: (req: Request) => void) {
  return {
    auth: {
      exchangeCodeForSession: vi.fn().mockImplementation(async () => {
        onExchange?.(lastRequest!);
        return result;
      }),
    },
  } as never;
}

let lastRequest: Request | null = null;

function call(url: string): Promise<Response> {
  lastRequest = new Request(url);
  return GET(lastRequest);
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    mockedCreate.mockReset();
    resetRateLimits();
  });

  it("400s without a code", async () => {
    const res = await call("https://app.test/auth/callback");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request", message: "Missing code." });
  });

  it("302s to the same-origin next and carries the session cookies", async () => {
    mockedCreate.mockImplementation(() =>
      clientThat({ error: null }, (req) =>
        recordCookies(req, [{ name: "sb-auth", value: "tok", options: { path: "/" } }]),
      ),
    );
    const res = await call("https://app.test/auth/callback?code=abc&next=/week");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/week");
    expect(res.headers.get("set-cookie")).toBe("sb-auth=tok; Path=/");
  });

  it("refuses an off-origin next", async () => {
    mockedCreate.mockReturnValue(clientThat({ error: null }));
    const res = await call("https://app.test/auth/callback?code=abc&next=//evil.test/x");
    expect(res.headers.get("location")).toBe("https://app.test/");
  });

  it("302s to /sign-in?error= when the exchange fails", async () => {
    mockedCreate.mockReturnValue(clientThat({ error: { message: "expired" } }));
    const res = await call("https://app.test/auth/callback?code=abc&next=/week");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/sign-in?error=exchange_failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app/auth/callback/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route" from "app/auth/callback/route.test.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `app/auth/callback/route.ts`:

```ts
/**
 * The magic-link landing (spec "API changes"). Exchanges the code for a
 * session, writes the session cookies onto the redirect, and only ever sends
 * the browser to a same-origin path.
 */

import { jsonError, safeNextPath } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { applyCookies, createRequestClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirect(to: URL): Response {
  return new Response(null, { status: 302, headers: { location: to.toString() } });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
    await enforceRateLimit(`auth:callback:${ip}`, 20, 60);
  } catch (e) {
    return jsonError(e);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return new Response(JSON.stringify({ error: "bad_request", message: "Missing code." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const next = safeNextPath(url.searchParams.get("next"));
  const client = createRequestClient(req);
  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) {
    return redirect(new URL("/sign-in?error=exchange_failed", url.origin));
  }

  return applyCookies(req, redirect(new URL(next, url.origin)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test app/auth/callback/route.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add app/auth/callback/route.ts app/auth/callback/route.test.ts
git commit -m "feat: add the auth callback route with same-origin redirect"
```

---

### Task 10: Browser client and the sign-in screen

**Files:**
- Create: `lib/supabase/client.ts`
- Create: `app/sign-in/page.tsx`
- Test: `lib/supabase/client.test.ts`

**Interfaces:**
- Consumes: `createBrowserClient` from `@supabase/ssr`.
- Produces:
  ```ts
  export function browserClient(): SupabaseClient;
  export function callbackRedirectUrl(origin: string, next: string): string;
  ```

`createBrowserClient` memoizes its own singleton inside `@supabase/ssr`, so `browserClient()` holds
no module-level client of its own and the §8 rule stands.

`app/sign-in/page.tsx` has no unit test: `vitest.config.ts` sets `environment: "node"` and
`include: ["**/*.test.ts"]`, which collects no `.tsx`, and that file belongs to no lane. Its logic
lives in `callbackRedirectUrl`, which is tested; the page itself is gated by `tsc`, `lint` and the
manual check in Step 6.

- [ ] **Step 1: Write the failing test**

Create `lib/supabase/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { callbackRedirectUrl } from "./client";

describe("callbackRedirectUrl", () => {
  it("points the magic link at this origin's callback and carries next", () => {
    expect(callbackRedirectUrl("https://app.test", "/week")).toBe(
      "https://app.test/auth/callback?next=%2Fweek",
    );
  });

  it("drops an off-origin next before it ever reaches the email", () => {
    expect(callbackRedirectUrl("https://app.test", "//evil.test")).toBe(
      "https://app.test/auth/callback?next=%2F",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/supabase/client.test.ts`
Expected: FAIL — `Failed to resolve import "./client" from "lib/supabase/client.test.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/supabase/client.ts`:

```ts
"use client";

/**
 * The browser-side Supabase client, used by the sign-in screen and AuthGate.
 * createBrowserClient keeps its own singleton inside @supabase/ssr, so this
 * module holds no client of its own.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

export function browserClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not set");
  }
  return createBrowserClient(url, key);
}

/**
 * Where the magic link should land. The `next` is sanitised before it is sent.
 *
 * The rule is the same one safeNextPath applies in lib/server/http.ts, written
 * out again here on purpose: this module ships to the browser, and importing
 * anything from lib/server/ would pull the server client into that bundle.
 * The route's own check is the one that actually protects the redirect.
 */
export function callbackRedirectUrl(origin: string, next: string): string {
  const safe =
    next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
  return `${origin}/auth/callback?next=${encodeURIComponent(safe)}`;
}
```

Create `app/sign-in/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { browserClient, callbackRedirectUrl } from "@/lib/supabase/client";

type Stage = "idle" | "sending" | "sent" | "error";

/**
 * One email field, one button, then "check your email" (spec "Client changes").
 * Glass card on the existing ground: 26px radius, 44px targets, existing tokens.
 */
export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [message, setMessage] = useState("");

  async function send(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const address = email.trim();
    if (address.length === 0) return;
    setStage("sending");
    const next = new URLSearchParams(window.location.search).get("next") ?? "/";
    const { error } = await browserClient().auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: callbackRedirectUrl(window.location.origin, next) },
    });
    if (error) {
      setStage("error");
      setMessage("That did not send. Check the address and try again.");
      return;
    }
    setStage("sent");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass w-full max-w-sm rounded-[26px] p-6">
        <h1 className="text-heading-sm font-bold text-charcoal">Sasha</h1>
        <p className="pt-1 text-caption text-muted">What to eat, and when.</p>

        {stage === "sent" ? (
          <p className="pt-6 text-body-sm text-graphite">
            Check your email. Tap the link on this phone and you are in.
          </p>
        ) : (
          <form onSubmit={send} className="flex flex-col gap-3 pt-6">
            <label htmlFor="email" className="text-caption text-muted">
              Your email
            </label>
            <input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="tap rounded-[26px] border border-hairline bg-paper px-4 text-body text-graphite"
            />
            <button
              type="submit"
              disabled={stage === "sending"}
              className="tap rounded-[26px] bg-tangerine px-4 text-body-sm font-semibold text-paper disabled:opacity-60"
            >
              {stage === "sending" ? "Sending…" : "Send me a link"}
            </button>
            {stage === "error" && <p className="text-caption text-alert">{message}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/supabase/client.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Type-check and lint the page**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: no errors

- [ ] **Step 6: Look at the screen once**

Run: `pnpm dev`, open `http://localhost:3000/sign-in`.
Expected: one glass card centred on the flame ground; the field and the button are each at least
44px tall; the card corners are 26px; no colour outside the existing tokens.

- [ ] **Step 7: Commit**

```bash
git add lib/supabase/client.ts lib/supabase/client.test.ts app/sign-in/page.tsx
git commit -m "feat: add the browser client and the email OTP sign-in screen"
```

---

### Task 11: AuthGate

**Files:**
- Create: `components/AuthGate.tsx`

**Interfaces:**
- Consumes: `browserClient()` from `lib/supabase/client.ts` (Task 10).
- Produces: `export default function AuthGate({ children }: { children: ReactNode }): JSX.Element`

No unit test, for the same reason as the sign-in page: vitest runs `environment: "node"` and collects
only `**/*.test.ts`, and `vitest.config.ts` belongs to no lane. This task is gated by `tsc`, `lint`
and the two manual checks in Step 3.

- [ ] **Step 1: Write the implementation**

Create `components/AuthGate.tsx`:

```tsx
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { browserClient } from "@/lib/supabase/client";

type Gate = "unknown" | "in" | "out";

/**
 * Wraps the tab shell (spec "Client changes").
 *
 * "unknown" renders the children, so a cold offline open still shows today from
 * local state instead of a spinner. The session check only ever downgrades to
 * the signed-out card. getSession is enough here because this is UI gating —
 * every server route proves identity for itself with getClaims().
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>("unknown");

  useEffect(() => {
    let alive = true;
    const supabase = browserClient();
    void supabase.auth.getSession().then(({ data }) => {
      if (alive) setGate(data.session ? "in" : "out");
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (alive) setGate(session ? "in" : "out");
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  if (gate === "out") {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <div className="glass w-full max-w-sm rounded-[26px] p-6">
          <h1 className="text-heading-sm font-bold text-charcoal">Signed out</h1>
          <p className="pt-1 text-caption text-muted">
            Your session ended. Sign in again and everything comes back.
          </p>
          <a
            href="/sign-in"
            className="tap mt-6 flex items-center justify-center rounded-[26px] bg-tangerine px-4 text-body-sm font-semibold text-paper"
          >
            Sign in
          </a>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
```

- [ ] **Step 2: Type-check and lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: no errors

- [ ] **Step 3: Check both states by hand**

Temporarily render `<AuthGate>` around the body of `app/page.tsx` in your working tree only — do not
commit that edit; `app/layout.tsx` is the integration branch's to change.
Run: `pnpm dev`, open `http://localhost:3000/`.
Expected, signed out: the page paints today's plan first, then swaps to the "Signed out" card.
Expected, signed in: the page never changes. Revert the temporary edit before committing.

- [ ] **Step 4: Commit**

```bash
git add components/AuthGate.tsx
git commit -m "feat: add AuthGate so a cold offline open still renders today"
```

---

### Task 12: MCP route auth swap

**Files:**
- Modify: `app/api/mcp/route.ts` — replace `guarded` (lines 244-253) and drop `bearerOk` from the
  `@/lib/server/db` import on line 7. Every `server.registerTool` block stays exactly as it is.
- Test: `tests/mcp/scope.test.ts`

**Interfaces:**
- Consumes: `withTokenUser`, `TokenUser` (Task 7); `enforceRateLimit` (Task 6); `HttpError` (Task 3);
  `jsonError` (Task 4); `isConfigured` from `lib/server/db.ts` (unchanged).
- Produces: `export { guarded as GET, guarded as POST, guarded as DELETE }` — unchanged export shape.

**Why the body is read first.** Read tools need `read`; `add_food`, `set_food_status`, `log_gut` and
`log_food` need `log:write`. The scope is a property of the JSON-RPC call, so the wrapper reads the
body once, picks the scope, and replays the body into a fresh `Request` for the handler. That keeps a
missing scope a real HTTP 403 instead of a tool-level error inside a 200.

**Why the `SASHA_USER_ID` check stays.** The tools still read the legacy single-tenant jsonb through
`lib/server/db.ts`, which has no `user_id` column. Until the cut-over, any user's token would
otherwise read Sasha's rows. Architecture §2.3 pins the legacy path to `SASHA_USER_ID` and gives any
other identity 404; this wrapper enforces that. The integration branch removes the check with the
legacy tables.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/scope.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTokenUser } from "@/lib/server/privileged";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { HttpError } from "@/lib/server/auth";

vi.mock("@/lib/server/privileged", () => ({ withTokenUser: vi.fn() }));
// db.ts imports "server-only", which throws outside a server component.
vi.mock("@/lib/server/db", () => ({
  isConfigured: () => true,
  pullAll: vi.fn().mockResolvedValue({ foods: {}, days: {}, settings: null }),
  pushRecords: vi.fn().mockResolvedValue(1),
}));

const { POST } = await import("@/app/api/mcp/route");
const mockedWith = vi.mocked(withTokenUser);

const SASHA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function rpc(method: string, name?: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: name ? { name, arguments: {} } : {} });
}

function post(body: string): Request {
  return new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: { authorization: "Bearer smc_x", "content-type": "application/json" },
    body,
  });
}

describe("the MCP scope gate", () => {
  beforeEach(() => {
    mockedWith.mockReset();
    resetRateLimits();
    vi.stubEnv("SASHA_USER_ID", SASHA);
    // Default: the boundary admits the caller and runs the callback.
    mockedWith.mockImplementation(async (_req, _scope, fn) =>
      fn({ userId: SASHA, tokenId: "tok-1", scopes: ["read", "log:write"] }, {} as never),
    );
  });

  it("asks for read on a read tool and on the tool listing", async () => {
    await POST(post(rpc("tools/call", "get_day")));
    expect(mockedWith.mock.calls[0][1]).toBe("read");
    mockedWith.mockClear();
    await POST(post(rpc("tools/list")));
    expect(mockedWith.mock.calls[0][1]).toBe("read");
  });

  it("asks for log:write on every writing tool", async () => {
    for (const tool of ["add_food", "set_food_status", "log_gut", "log_food"]) {
      mockedWith.mockClear();
      await POST(post(rpc("tools/call", tool)));
      expect(mockedWith.mock.calls[0][1]).toBe("log:write");
    }
  });

  it("turns the boundary's 403 into an HTTP 403", async () => {
    mockedWith.mockRejectedValue(new HttpError(403, "forbidden", 'Token lacks the "log:write" scope.'));
    const res = await POST(post(rpc("tools/call", "log_food")));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", message: 'Token lacks the "log:write" scope.' });
  });

  it("turns the boundary's 401 into an HTTP 401 with a challenge", async () => {
    mockedWith.mockRejectedValue(new HttpError(401, "unauthorized", "Unknown, revoked or expired token."));
    const res = await POST(post(rpc("tools/call", "get_day")));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("413s a body over 64 KB", async () => {
    const res = await POST(post(JSON.stringify({ method: "tools/call", params: { name: "log_food", pad: "x".repeat(70_000) } })));
    expect(res.status).toBe(413);
  });

  it("404s a token that belongs to someone other than Sasha", async () => {
    mockedWith.mockImplementation(async (_req, _scope, fn) =>
      fn({ userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", tokenId: "tok-2", scopes: ["read"] }, {} as never),
    );
    const res = await POST(post(rpc("tools/call", "get_day")));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "No data for this user." });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/mcp/scope.test.ts`
Expected: FAIL — `expected "spy" to be called at least once` on the first test (the route still calls
`bearerOk`, not `withTokenUser`)

- [ ] **Step 3: Write minimal implementation**

In `app/api/mcp/route.ts`, change the import on line 7 from

```ts
import { bearerOk, isConfigured, pullAll, pushRecords } from "@/lib/server/db";
```

to

```ts
import { isConfigured, pullAll, pushRecords } from "@/lib/server/db";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { withTokenUser } from "@/lib/server/privileged";
import { enforceRateLimit } from "@/lib/server/ratelimit";
```

Then replace the whole `guarded` function (lines 244-253) with:

```ts
const MAX_BODY_BYTES = 64 * 1024;

/** Tools that change her data. Everything else only reads. */
const WRITE_TOOLS = new Set(["add_food", "set_food_status", "log_gut", "log_food"]);

/** The scope this JSON-RPC body needs. Anything unparseable falls back to read. */
function scopeForBody(raw: string): "read" | "log:write" {
  if (raw.length === 0) return "read";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "read";
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  for (const call of calls) {
    const c = call as { method?: unknown; params?: { name?: unknown } };
    if (c.method === "tools/call" && typeof c.params?.name === "string" && WRITE_TOOLS.has(c.params.name)) {
      return "log:write";
    }
  }
  return "read";
}

async function guarded(req: Request): Promise<Response> {
  try {
    const raw = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      throw new HttpError(413, "too_large", `Body over ${MAX_BODY_BYTES} bytes.`);
    }

    return await withTokenUser(req, scopeForBody(raw), async (ctx) => {
      await enforceRateLimit(`mcp:${ctx.tokenId}`, 60, 60);

      // The tools still read the legacy single-tenant jsonb through
      // lib/server/db.ts, which has no user_id column. Architecture §2.3 pins
      // that path to SASHA_USER_ID; any other identity gets 404. The cut-over
      // deletes this check along with the legacy tables.
      if (ctx.userId !== process.env.SASHA_USER_ID) {
        throw new HttpError(404, "not_found", "No data for this user.");
      }
      if (!isConfigured()) throw new HttpError(503, "unavailable", "Sync is not configured.");

      const replayed =
        raw.length === 0
          ? req
          : new Request(req.url, { method: req.method, headers: req.headers, body: raw });
      return handler(replayed);
    });
  } catch (e) {
    const res = jsonError(e);
    if (res.status === 401) res.headers.set("WWW-Authenticate", "Bearer");
    return res;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/mcp/scope.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Confirm nothing else in the file moved**

Run: `git diff --stat app/api/mcp/route.ts`
Expected: one file changed, roughly `+55 −10`, and `git diff app/api/mcp/route.ts` shows changes only
on the import line and inside `guarded`. No `registerTool` block appears in the diff.

- [ ] **Step 6: Commit**

```bash
git add app/api/mcp/route.ts tests/mcp/scope.test.ts
git commit -m "feat: gate the MCP route with api_tokens scopes instead of a shared bearer"
```

---

### Task 13: Token minting script

**Files:**
- Create: `scripts/mint-token.ts`

**Interfaces:**
- Consumes: `adminClient()` (Task 5); `mintToken`, `toBytea` (Task 1); Lane A's `api_tokens` table.
- Produces: a CLI. No exports.

Two ways to run this script are available on `main` (contracts §7): `pnpm exec tsx
scripts/mint-token.ts …` (tsx is a devDependency already, and resolves the `@/` tsconfig alias), or
Node 22's own `--experimental-strip-types` (no path mapping, so relative imports must carry the
`.ts` extension). This script uses relative `.ts` imports below, which run under either — no lane
needs to add a dependency for it.

- [ ] **Step 1: Write the failing check**

Run: `node --experimental-strip-types scripts/mint-token.ts` (or `pnpm exec tsx scripts/mint-token.ts`)
Expected: FAIL — `Cannot find module '…/scripts/mint-token.ts'`

- [ ] **Step 2: Write the implementation**

Create `scripts/mint-token.ts`:

```ts
/**
 * Mint one personal access token for SASHA_USER_ID and print it once.
 *
 *   node --env-file=.env.local --experimental-strip-types scripts/mint-token.ts "Codex CLI" read log:write
 *   pnpm exec tsx scripts/mint-token.ts "Codex CLI" read log:write   # equivalent (contracts §7)
 *
 * Only the SHA-256 hash reaches the database. The raw token is shown once and
 * never again — put it in ZS Vault straight away.
 */

import { adminClient } from "../lib/server/admin.ts";
import { mintToken, toBytea } from "../lib/server/tokens.ts";

const ALLOWED_SCOPES = new Set(["read", "log:write"]);

async function main(): Promise<void> {
  const [label, ...scopes] = process.argv.slice(2);
  if (!label) {
    console.error('usage: mint-token.ts "<label>" [read] [log:write]');
    process.exit(1);
  }

  const userId = process.env.SASHA_USER_ID;
  if (!userId) {
    console.error("SASHA_USER_ID is not set. Sign Sasha in first, then copy her auth.users id.");
    process.exit(1);
  }

  const wanted = scopes.length > 0 ? scopes : ["read"];
  for (const scope of wanted) {
    if (!ALLOWED_SCOPES.has(scope)) {
      console.error(`Unknown scope "${scope}". Use read or log:write.`);
      process.exit(1);
    }
  }

  const { raw, hash } = mintToken();
  const { data, error } = await adminClient()
    .from("api_tokens")
    .insert({ label, user_id: userId, token_hash: toBytea(hash), scopes: wanted })
    .select("id")
    .single();

  if (error) {
    console.error(`Insert failed: ${error.message}`);
    process.exit(1);
  }

  console.log(`token id: ${data.id}`);
  console.log(`label:    ${label}`);
  console.log(`scopes:   ${wanted.join(" ")}`);
  console.log(`token:    ${raw}`);
  console.log("Shown once. Store it now; the database holds only the hash.");
}

await main();
```

- [ ] **Step 3: Run the argument guards, which need no database**

Run: `node --experimental-strip-types scripts/mint-token.ts`
Expected: `usage: mint-token.ts "<label>" [read] [log:write]`, exit code 1

Run: `SASHA_USER_ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa node --experimental-strip-types scripts/mint-token.ts "Codex CLI" write-everything`
Expected: `Unknown scope "write-everything". Use read or log:write.`, exit code 1

- [ ] **Step 4: Mint one real token against the branch** [needs branch]

Run:
```bash
SUPABASE_URL="$SUPABASE_TEST_URL" \
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_TEST_SERVICE_ROLE_KEY" \
SASHA_USER_ID="<the branch user id>" \
node --experimental-strip-types scripts/mint-token.ts "Codex CLI" read log:write
```
Expected: four lines, the last token starting `smc_`.
Skip condition for CI: `SUPABASE_TEST_URL` or `SUPABASE_TEST_SERVICE_ROLE_KEY` unset — run Step 3
only, and leave this step unchecked with a note in the PR body.

- [ ] **Step 5: Type-check and lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add scripts/mint-token.ts
git commit -m "feat: add mint-token script for api_tokens"
```

---

### Task 14: Cross-user token test on a branch

**Files:**
- Create: `tests/mcp/token.test.ts`

**Interfaces:**
- Consumes: `withTokenUser` (Task 7); `mintToken`, `toBytea` (Task 1); Lane A's `api_tokens` table and
  `lookup_api_token` RPC.
- Produces: no exports.

`tests/mcp/token.test.ts` is **the** canonical MCP cross-user test for spec acceptance criterion 7 —
not half of one, and not a stand-in for a `tests/privileged/**` file (contracts §1 gives this lane
`tests/mcp/**`; no lane owns `tests/privileged/`). It proves the token → `user_id` resolution against
the real RPC. The route's own tenancy is still pinned to `SASHA_USER_ID` until the cut-over, so the
route-level "user A cannot reach user B" assertion is the 404 case already covered in Task 12.

- [ ] **Step 1: Write the failing test** [needs branch]

Create `tests/mcp/token.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mintToken, toBytea } from "@/lib/server/tokens";
import { withTokenUser } from "@/lib/server/privileged";

const URL = process.env.SUPABASE_TEST_URL;
const KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const ready = Boolean(URL && KEY);

function req(raw: string): Request {
  return new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${raw}` },
  });
}

describe.skipIf(!ready)("api_tokens on a Supabase branch", () => {
  let setup: SupabaseClient;
  let userA = "";
  let userB = "";
  const tokenA = mintToken();
  const tokenB = mintToken();
  const revoked = mintToken();
  const expired = mintToken();

  beforeAll(async () => {
    // adminClient() is lazy, so stubbing before the first call points it at the branch.
    vi.stubEnv("SUPABASE_URL", URL as string);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", KEY as string);
    setup = createClient(URL as string, KEY as string, { auth: { persistSession: false } });

    const a = await setup.auth.admin.createUser({ email: "lane-b-a@example.test", email_confirm: true });
    const b = await setup.auth.admin.createUser({ email: "lane-b-b@example.test", email_confirm: true });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    userA = a.data.user!.id;
    userB = b.data.user!.id;

    const { error } = await setup.from("api_tokens").insert([
      { label: "A full", user_id: userA, token_hash: toBytea(tokenA.hash), scopes: ["read", "log:write"] },
      { label: "B read", user_id: userB, token_hash: toBytea(tokenB.hash), scopes: ["read"] },
      { label: "A revoked", user_id: userA, token_hash: toBytea(revoked.hash), scopes: ["read"], revoked_at: new Date().toISOString() },
      { label: "A expired", user_id: userA, token_hash: toBytea(expired.hash), scopes: ["read"], expires_at: "2020-01-01T00:00:00Z" },
    ]);
    expect(error).toBeNull();
  });

  afterAll(async () => {
    if (!ready) return;
    await setup.from("api_tokens").delete().in("user_id", [userA, userB]);
    await setup.auth.admin.deleteUser(userA);
    await setup.auth.admin.deleteUser(userB);
    vi.unstubAllEnvs();
  });

  it("resolves a token to its own user and never to the other one", async () => {
    const seenA = await withTokenUser(req(tokenA.raw), "read", async (ctx) => ctx.userId);
    const seenB = await withTokenUser(req(tokenB.raw), "read", async (ctx) => ctx.userId);
    expect(seenA).toBe(userA);
    expect(seenB).toBe(userB);
    expect(seenA).not.toBe(seenB);
  });

  it("401s a revoked, an expired and a never-issued token", async () => {
    for (const raw of [revoked.raw, expired.raw, mintToken().raw]) {
      await expect(withTokenUser(req(raw), "read", async () => "reached")).rejects.toMatchObject({
        status: 401,
      });
    }
  });

  it("403s user B's read-only token when log:write is required", async () => {
    await expect(withTokenUser(req(tokenB.raw), "log:write", async () => "reached")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("bumps last_used_at on a successful lookup", async () => {
    await withTokenUser(req(tokenA.raw), "read", async () => "ok");
    const { data } = await setup
      .from("api_tokens")
      .select("last_used_at")
      .eq("token_hash", toBytea(tokenA.hash))
      .single();
    expect(data?.last_used_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it with no branch and confirm it skips**

Run: `pnpm test tests/mcp/token.test.ts`
Expected: PASS — `4 skipped`, 0 failed. This is the CI behaviour: the suite stays green without a
branch, exactly as `00-contracts.md` §7 requires.

- [ ] **Step 3: Run it against the branch** [needs branch]

Run:
```bash
SUPABASE_TEST_URL="https://<branch-ref>.supabase.co" \
SUPABASE_TEST_SERVICE_ROLE_KEY="<branch service role key>" \
pnpm exec vitest run tests/mcp/token.test.ts
```
Expected: FAIL first — `Could not find the function public.lookup_api_token(p_token_hash)` if Lane A's
`…000400_privileged.sql` and `…000600_rpc.sql` are not applied to the branch yet. Apply them
(Lane A's `pnpm db:push`), then re-run.
Expected after: PASS — 4 tests.
Skip condition for CI: either variable unset, and the suite skips as in Step 2.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/token.test.ts
git commit -m "test: add cross-user token boundary test against a supabase branch"
```

---

## Lane exit gate

Run in order from the repo root on `feat/p0-auth`:

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test lib/server/tokens.test.ts lib/server/auth.test.ts lib/server/http.test.ts \
  lib/server/admin.test.ts lib/server/ratelimit.test.ts lib/server/privileged.test.ts \
  lib/supabase/server.test.ts lib/supabase/client.test.ts middleware.test.ts \
  app/auth/callback/route.test.ts tests/mcp/scope.test.ts tests/mcp/token.test.ts
pnpm build
git diff --stat main...HEAD
```

Expected:

| Command | Expected result |
|---|---|
| `pnpm lint` | no errors, no warnings |
| `pnpm exec tsc --noEmit` | no output |
| the `pnpm test` line | 12 test files, 0 failed; `tests/mcp/token.test.ts` shows 4 skipped without branch credentials |
| `pnpm build` | compiles; the route list includes `/sign-in`, `/auth/callback`, `/api/mcp`; middleware is listed |
| `git diff --stat main...HEAD` | exactly the 25 files in the File structure table, and nothing else — in particular no `app/layout.tsx`, no `package.json`, no `vitest.config.ts`, no `lib/server/db.ts` |

Then the two facts the spec asserts by name:

```bash
git grep -l SUPABASE_SERVICE_ROLE_KEY -- '*.ts' '*.tsx' ':!*.test.ts'
git grep -n "SASHA_MCP_TOKEN" -- app lib
```

Expected: the first prints `lib/server/admin.ts` and `lib/server/db.ts` (db.ts goes at cut-over, not
here). The second prints nothing — the MCP route no longer reads that env var.

Do **not** run `pnpm test` with no filter as a pre-PR gate. CI runs the full suite once on the PR.

## Hand-off to integration

The integration branch owns four edits this lane deliberately did not make.

1. **Wire `AuthGate` into `app/layout.tsx`.** Import it and wrap only `{children}` — `Ground`,
   `ServiceWorkerRegistrar`, `InstallPrompt`, `SyncBootstrap` and `TabBar` stay outside it, so the
   ground and the tab bar still paint on the signed-out card:
   ```tsx
   import AuthGate from "@/components/AuthGate";
   // …
   <AuthGate>{children}</AuthGate>
   ```
2. **Remove the single-tenant pin from `app/api/mcp/route.ts`.** When `lib/server/db.ts` and the
   legacy tables go, delete the `ctx.userId !== process.env.SASHA_USER_ID` block and the
   `isConfigured()` guard together with the `@/lib/server/db` import, and point the tools at the new
   user tables through the `admin` client that `withTokenUser` already hands the callback as its
   second argument. `withTokenUser` itself needs no change.
3. **Tighten `lib/server/admin.test.ts`.** Once `lib/server/db.ts` is deleted, change the expected
   array from `["lib/server/admin.ts", "lib/server/db.ts"]` to `["lib/server/admin.ts"]`. That is the
   moment spec acceptance criterion 6 is truly met.
4. **Retire `SASHA_MCP_TOKEN` and `SASHA_SYNC_TOKEN` from `.env.example` and Vercel**, and mint
   Sasha's real token with `scripts/mint-token.ts` after her first sign-in creates her `auth.users`
   row (spec open question 4 — `SASHA_USER_ID` cannot be known before that).

What the other lanes may rely on, unchanged, from this lane's files:

- Lane C's `app/api/sync/ops/route.ts` and `app/api/sync/changes/route.ts`: `enforceRateLimit(key, 60, 60)`
  first, then `requireUser(req)` for `{ userId, client }`, then `readJson(req, schema, 1_048_576)`,
  and `jsonError(e)` in one `catch`. The `client` returned by `requireUser` is the RLS-scoped,
  request-local client to query with — never `adminClient()`.
- Lane D's `app/api/export/route.ts`: the same order with `enforceRateLimit(key, 10, 3600)` and
  `readJson(..., 16_384)`. `app/api/jobs/backup/route.ts` and `lib/ai/adapter.ts` take
  `adminClient()` from `lib/server/admin.ts` — they must not create their own service-role client, or
  acceptance criterion 6 fails.
- Nobody else may write `SUPABASE_SERVICE_ROLE_KEY` into a source file.

## Open questions

1. **The rate-limit store.** Phase 0 ships the in-instance `Map`. On Vercel the real ceiling is
   `limit × live instances` and a cold start forgets the window, so the numbers in the §5 matrix
   (60/min, 10/hour, 20/min) are soft for now. The `rate_limits(key, window_start, count)` table
   through `adminClient()` is the exact version and the documented follow-up. Devin decides whether
   that lands in Phase 1 or waits for a second user.
2. **Email OTP sender** — spec open question 3, unchanged by this lane. Supabase's built-in SMTP is
   rate-limited and not meant for production. For one user the built-in limit may be acceptable; a
   custom SMTP sender is the alternative. `app/sign-in/page.tsx` works either way.
3. **`SASHA_USER_ID` ordering** — spec open question 4. `scripts/mint-token.ts` and the MCP route's
   single-tenant pin both need an `auth.users` id that does not exist until Sasha's first sign-in.
   Either accept the ordering (sign in on release A, then mint the token, then run the backfill) or
   pre-create her user by invite.
4. **The magic link and the PWA.** The link opens in Safari, not in the installed PWA, so the session
   cookie lands in the browser's cookie store. Whether the installed app sees it depends on iOS
   sharing cookies between the two; if it does not, sign-in has to happen inside the installed app.
   This is the first thing to check in the manual gate, and it may force a switch from a magic link
   to a typed six-digit OTP (`verifyOtp`), which `signInWithOtp` already sends alongside the link.
5. **`WWW-Authenticate` on MCP 401s.** This lane keeps the bare `Bearer` challenge the old wrapper
   sent. `mcp-handler` also ships `protectedResourceHandler` for RFC 9728 discovery. Codex does not
   need it today; wire it if another MCP client asks for it.
