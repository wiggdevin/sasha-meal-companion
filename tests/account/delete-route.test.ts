/**
 * Self-serve account deletion at the route edge (`POST /api/account/delete`,
 * `GET /api/account/delete/enabled`), with the session and the admin client faked:
 *
 * - dark: with ACCOUNT_DELETION_ENABLED unset the POST answers 404 `not_enabled` before any
 *   session, limiter or database work, and the probe answers `{ enabled: false }`;
 * - identity is the verified session only; the limiter fails closed;
 * - a session whose sign-in is older than 10 minutes (or has no `amr`) gets 401 `reauth_required`;
 * - order: Storage first, then `delete_account`, then the Auth admin delete; a Storage failure
 *   stops before the database is touched;
 * - idempotent: an account already gone answers 200 `already_gone`, and "user not found" from
 *   the Auth admin API counts as done;
 * - a database without the function (42883, or PostgREST's PGRST202) answers 503
 *   `account_deletion_unavailable` and never reaches the Auth delete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits, setRateLimitStore } from "@/lib/server/ratelimit";

vi.mock("server-only", () => ({}));
const mocked = vi.hoisted(() => ({ requireUser: vi.fn(), admin: null as unknown }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: mocked.requireUser,
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => mocked.admin }));

const { HttpError } = await import("@/lib/server/auth");
const { POST } = await import("@/app/api/account/delete/route");
const { GET } = await import("@/app/api/account/delete/enabled/route");
const { RECENT_SIGN_IN_SECONDS, lastSignInAt } = await import("@/lib/server/account-delete");

const USER = "11111111-1111-4111-8111-111111111111";
const nowSeconds = () => Math.floor(Date.now() / 1000);

type Calls = string[];

function fakeAdmin(opts: {
  objects?: string[]; listError?: unknown; rpc?: { data: unknown; error: unknown };
  authError?: unknown;
} = {}) {
  const calls: Calls = [];
  let objects = [...(opts.objects ?? [])];
  const admin = {
    storage: {
      from: (bucket: string) => ({
        list: async (prefix: string) => {
          calls.push(`list:${bucket}/${prefix}`);
          if (opts.listError) return { data: null, error: opts.listError };
          return { data: objects.map((name) => ({ name, id: `id-${name}` })), error: null };
        },
        remove: async (paths: string[]) => {
          calls.push(`remove:${paths.join(",")}`);
          objects = objects.filter((name) => !paths.includes(`${USER}/${name}`));
          return { data: [], error: null };
        },
      }),
    },
    rpc: vi.fn(async (fn: string, args: unknown) => {
      calls.push(`rpc:${fn}:${JSON.stringify(args)}`);
      return opts.rpc ?? { data: { status: "deleted" }, error: null };
    }),
    auth: { admin: { deleteUser: vi.fn(async (id: string) => {
      calls.push(`auth:${id}`);
      return { data: null, error: opts.authError ?? null };
    }) } },
  };
  mocked.admin = admin;
  return { admin, calls };
}

function session(amr: unknown = [{ method: "otp", timestamp: nowSeconds() - 60 }]) {
  mocked.requireUser.mockResolvedValue({
    userId: USER,
    client: { auth: { getClaims: async () => ({ data: { claims: { sub: USER, amr } }, error: null }) } },
  });
}

const post = (body: unknown = { confirm: "DELETE" }) => POST(new Request("https://app.test/api/account/delete", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const probe = () => GET(new Request("https://app.test/api/account/delete/enabled"));

beforeEach(() => {
  resetRateLimits();
  mocked.requireUser.mockReset();
  vi.stubEnv("ACCOUNT_DELETION_ENABLED", "1");
  session();
});
afterEach(() => { vi.unstubAllEnvs(); setRateLimitStore(null); vi.restoreAllMocks(); });

describe("the flag (ACCOUNT_DELETION_ENABLED)", () => {
  it("flag off: 404 not_enabled before any session, limiter or database work", async () => {
    vi.stubEnv("ACCOUNT_DELETION_ENABLED", "");
    const { calls } = fakeAdmin();
    const res = await post();
    expect([res.status, (await res.json()).error]).toEqual([404, "not_enabled"]);
    expect(mocked.requireUser).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("the probe answers the switch for a signed-in session, uncached", async () => {
    vi.stubEnv("ACCOUNT_DELETION_ENABLED", "");
    let res = await probe();
    expect([res.status, await res.json(), res.headers.get("Cache-Control")])
      .toEqual([200, { enabled: false }, "private, no-store"]);
    vi.stubEnv("ACCOUNT_DELETION_ENABLED", "1");
    res = await probe();
    expect([res.status, await res.json()]).toEqual([200, { enabled: true }]);
  });

  it("the probe requires a session", async () => {
    mocked.requireUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    const res = await probe();
    expect(res.status).toBe(401);
  });
});

describe("auth, limiter and re-auth", () => {
  it("auth: no session is 401 and nothing is deleted", async () => {
    mocked.requireUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    const { calls } = fakeAdmin();
    const res = await post();
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("auth: an account header for another account is refused (409), never trusted", async () => {
    mocked.requireUser.mockRejectedValue(new HttpError(409, "account_mismatch", "Another account."));
    const { calls } = fakeAdmin();
    expect((await post()).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("limiter: fails closed (503) when the shared limiter is unavailable", async () => {
    setRateLimitStore({ hit: async () => { throw new Error("rate_limit_hit failed"); } });
    const { calls } = fakeAdmin();
    const res = await post();
    expect([res.status, (await res.json()).error]).toEqual([503, "rate_limit_unavailable"]);
    expect(calls).toEqual([]);
  });

  it("limiter: a sixth request in ten minutes is 429", async () => {
    fakeAdmin({ rpc: { data: { status: "already_gone" }, error: null } });
    for (let i = 0; i < 5; i += 1) expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });

  it("reauth: a sign-in older than 10 minutes is 401 reauth_required and nothing is deleted", async () => {
    session([{ method: "otp", timestamp: nowSeconds() - RECENT_SIGN_IN_SECONDS - 5 }]);
    const { calls } = fakeAdmin({ objects: ["a.jpg"] });
    const res = await post();
    expect([res.status, (await res.json()).error]).toEqual([401, "reauth_required"]);
    expect(calls).toEqual([]);
  });

  it("reauth: a session with no amr is 401 reauth_required", async () => {
    session(null);
    fakeAdmin();
    expect((await (await post()).json()).error).toBe("reauth_required");
  });

  it("reauth: the newest amr entry counts", () => {
    expect(lastSignInAt({ amr: [{ method: "password", timestamp: 10 }, { method: "otp", timestamp: 20 }] })).toBe(20);
    expect(lastSignInAt({ amr: "nope" })).toBeNull();
  });

  it("the typed confirmation travels with the request: a body without it is 400", async () => {
    const { calls } = fakeAdmin();
    expect((await post({})).status).toBe(400);
    expect((await post({ confirm: "delete" })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("deleting", () => {
  it("removes Storage first, then calls delete_account for the session user, then the Auth delete", async () => {
    const { calls } = fakeAdmin({ objects: ["a.jpg", "b.m4a"] });
    const res = await post();
    expect([res.status, await res.json(), res.headers.get("Cache-Control")])
      .toEqual([200, { status: "deleted" }, "no-store"]);
    expect(calls).toEqual([
      `list:media/${USER}`, `remove:${USER}/a.jpg,${USER}/b.m4a`, `list:media/${USER}`,
      `rpc:delete_account:{"p_user_id":"${USER}"}`, `auth:${USER}`,
    ]);
  });

  it("a Storage failure stops before the database: 503, the account is whole", async () => {
    const { calls } = fakeAdmin({ listError: { message: "down" } });
    const res = await post();
    expect([res.status, (await res.json()).error]).toEqual([503, "storage_unavailable"]);
    expect(calls.some((c) => c.startsWith("rpc:") || c.startsWith("auth:"))).toBe(false);
  });

  it("idempotent: an account already gone answers 200 already_gone; Auth 'not found' is done", async () => {
    fakeAdmin({ rpc: { data: { status: "already_gone" }, error: null },
      authError: { status: 404, code: "user_not_found", message: "User not found" } });
    const first = await post();
    const second = await post();
    expect([first.status, await first.json()]).toEqual([200, { status: "already_gone" }]);
    expect([second.status, await second.json()]).toEqual([200, { status: "already_gone" }]);
  });

  it.each([["42883"], ["PGRST202"]])("missing function (%s): 503 account_deletion_unavailable, no Auth delete", async (code) => {
    const { calls } = fakeAdmin({ rpc: { data: null, error: { code, message: "function public.delete_account(uuid) does not exist" } } });
    const res = await post();
    expect([res.status, (await res.json()).error]).toEqual([503, "account_deletion_unavailable"]);
    expect(calls.some((c) => c.startsWith("auth:"))).toBe(false);
  });

  it("any other database failure is 502 and never reaches the Auth delete", async () => {
    const { calls } = fakeAdmin({ rpc: { data: null, error: { code: "40P01", message: "deadlock" } } });
    expect((await post()).status).toBe(502);
    expect(calls.some((c) => c.startsWith("auth:"))).toBe(false);
  });

  it("an Auth admin failure other than 'not found' is 502 (safe to retry)", async () => {
    fakeAdmin({ authError: { status: 500, message: "boom" } });
    expect((await post()).status).toBe(502);
  });
});
