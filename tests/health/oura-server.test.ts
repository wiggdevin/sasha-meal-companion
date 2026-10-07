import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openOauth, sealOauth } from "@/lib/server/crypto";
import { accessTokenFor, completeOura, ouraAuthorizeUrl, pullTwoDays } from "@/lib/server/oura";

const KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  vi.stubEnv("HEALTH_TOKEN_KEY", KEY);
  vi.stubEnv("OURA_CLIENT_ID", "cid");
  vi.stubEnv("OURA_CLIENT_SECRET", "secret");
  vi.stubEnv("OURA_REDIRECT_URI", "https://app.test/api/health/oura/callback");
});

describe("ouraAuthorizeUrl", () => {
  it("carries client_id, redirect_uri, scope and state and no secret", () => {
    const url = new URL(ouraAuthorizeUrl("abc"));
    expect(url.origin + url.pathname).toBe("https://cloud.ouraring.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("daily personal");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.search).not.toContain("secret");
  });
});

describe("completeOura", () => {
  function stubAdmin(stateRow: { user_id: string } | null, existing: { id: string } | null = null) {
    const consume = vi.fn().mockResolvedValue({ data: stateRow, error: null });
    const lookup = vi.fn().mockResolvedValue({ data: existing, error: null });
    const updateRow = vi.fn((_row: unknown) => ({ eq: () => ({ eq: () => ({ select: () =>
      ({ single: vi.fn().mockResolvedValue({ data: { id: existing?.id }, error: null }) }) }) }) }));
    const insertRow = vi.fn((_row: unknown) => ({ select: () =>
      ({ single: vi.fn().mockResolvedValue({ data: { id: "src-new" }, error: null }) }) }));
    const order = () => ({ order, limit: () => ({ maybeSingle: lookup }) });
    return { admin: { from: vi.fn((table: string) => table === "oauth_states"
        ? { update: () => ({ eq: () => ({ is: () => ({ gt: () => ({ select: () =>
            ({ maybeSingle: consume }) }) }) }) }) }
        : { select: () => ({ eq: () => ({ eq: () => ({ order }) }) }),
          update: updateRow, insert: insertRow }) } as never,
      consume, updateRow, insertRow };
  }

  const tokenFetch = () => vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 86400,
      scope: "daily personal" }), { status: 200 }));

  it("inserts a new source on the first connect", async () => {
    const { admin, insertRow, updateRow } = stubAdmin({ user_id: "user-1" });
    const result = await completeOura(admin, { state: "good", code: "c" },
      { fetchFn: tokenFetch() });
    expect(result).toEqual({ sourceId: "src-new", userId: "user-1" });
    expect(insertRow).toHaveBeenCalledWith(expect.objectContaining({ user_id: "user-1",
      kind: "oura", revoked_at: null }));
    expect(updateRow).not.toHaveBeenCalled();
  });

  it("reuses the account's existing source on a reconnect and clears its revocation", async () => {
    const { admin, insertRow, updateRow } = stubAdmin({ user_id: "user-1" }, { id: "src-o" });
    const result = await completeOura(admin, { state: "good", code: "c" },
      { fetchFn: tokenFetch() });
    expect(result).toEqual({ sourceId: "src-o", userId: "user-1" });
    expect(updateRow).toHaveBeenCalledWith(expect.objectContaining({ revoked_at: null }));
    expect(insertRow).not.toHaveBeenCalled();
  });

  it("400s an unknown, consumed or expired state and writes nothing", async () => {
    const { admin, insertRow, updateRow } = stubAdmin(null);
    await expect(completeOura(admin, { state: "nope", code: "c" }))
      .rejects.toMatchObject({ status: 400, code: "bad_state" });
    expect(insertRow).not.toHaveBeenCalled();
    expect(updateRow).not.toHaveBeenCalled();
  });

  it("exchanges the code server-side and stores only a sealed token", async () => {
    const { admin, insertRow } = stubAdmin({ user_id: "user-1" });
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ access_token: "at",
      refresh_token: "rt", expires_in: 86400, scope: "daily personal" }), { status: 200 }));
    await completeOura(admin, { state: "good", code: "c" }, { fetchFn });
    const sent = String((fetchFn.mock.calls[0][1] as RequestInit).body);
    expect(sent).toContain("client_secret=secret");
    const stored = insertRow.mock.calls[0][0] as { oauth: string };
    expect(stored.oauth).not.toContain("access_token");
    expect(openOauth(stored.oauth).access_token).toBe("at");
  });

  it("502s a failed exchange", async () => {
    const { admin } = stubAdmin({ user_id: "user-1" });
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("nope", { status: 400 }));
    await expect(completeOura(admin, { state: "good", code: "c" }, { fetchFn }))
      .rejects.toMatchObject({ status: 502, code: "exchange_failed" });
  });
});

describe("accessTokenFor", () => {
  const sealed = (expiresAt: string) => sealOauth({ access_token: "at", refresh_token: "rt",
    expires_at: expiresAt, scope: "daily personal" }, Buffer.from(KEY, "base64"));

  it("returns the stored token when it is not near expiry", async () => {
    const admin = { from: vi.fn() } as never;
    const token = await accessTokenFor(admin, { id: "s", user_id: "u",
      oauth: sealed("2026-09-15T23:00:00Z") }, { now: new Date("2026-09-15T14:00:00Z") });
    expect(token).toBe("at");
  });

  it("rotates the refresh token in one compare-and-swap update", async () => {
    const eqOauth = vi.fn().mockResolvedValue({ data: { id: "s" }, error: null });
    const update = vi.fn(() => ({ eq: () => ({ eq: eqOauth }) }));
    const admin = { from: vi.fn(() => ({ update })) } as never;
    const old = sealed("2026-09-15T14:01:00Z");
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ access_token: "at2",
      refresh_token: "rt2", expires_in: 86400, scope: "daily personal" }), { status: 200 }));

    const token = await accessTokenFor(admin, { id: "s", user_id: "u", oauth: old },
      { fetchFn, now: new Date("2026-09-15T14:00:00Z") });
    expect(token).toBe("at2");
    // The old sealed value is the CAS key, so a concurrent refresh cannot win twice.
    expect(eqOauth).toHaveBeenCalledWith("oauth", old);
    expect(String(fetchFn.mock.calls[0][1] && (fetchFn.mock.calls[0][1] as RequestInit).body))
      .toContain("grant_type=refresh_token");
  });
});

describe("pullTwoDays", () => {
  it("requests the previous two local days and applies through the RPCs", async () => {
    const rpc = vi.fn(async (name: string) => name === "health_ingest_event"
      ? { data: [{ id: "ev-o", is_new: true }], error: null }
      : { data: [{ accepted: 4, updated: 0, skipped: 2 }], error: null });
    const admin = { rpc, from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () =>
      ({ data: { status: "applied" }, error: null }) }) }) })) } as never;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("daily_activity")) {
        return new Response(JSON.stringify({ data: [{ id: "a1", day: "2026-09-14", steps: 9000,
          active_calories: 400 }] }), { status: 200 });
      }
      if (path.includes("daily_readiness")) {
        return new Response(JSON.stringify({ data: [{ id: "r1", day: "2026-09-14", score: 70 }] }),
          { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "s1", day: "2026-09-14",
        bedtime_start: "2026-09-13T23:00:00Z", bedtime_end: "2026-09-14T07:00:00Z",
        total_sleep_duration: 26640, time_in_bed: 29160 }] }), { status: 200 });
    });

    // Far-future expiry: pullTwoDays reads the real clock, and a token sealed to expire on a fixed
    // date turned this test red the morning that date arrived (2026-09-16). Expiry is the
    // refresh test's job above; this one is about the two-day window.
    const sealedRow = sealOauth({ access_token: "at", refresh_token: "rt",
      expires_at: "2099-01-01T00:00:00Z", scope: "daily personal" }, Buffer.from(KEY, "base64"));
    const out = await pullTwoDays(admin, { id: "src-o", user_id: "user-1", oauth: sealedRow },
      "2026-09-15", { fetchFn });

    expect(out).toEqual({ inserted: 4, updated: 0, skipped: 2 });
    expect(String(fetchFn.mock.calls[0][0])).toContain("start_date=2026-09-13");
    expect(String(fetchFn.mock.calls[0][0])).toContain("end_date=2026-09-15");
  });
});
