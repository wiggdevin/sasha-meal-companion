/**
 * W025 (audit A011, A117, P12): a 401 really refreshes, once per pull, and the rotated pair is
 * stored by a checked compare-and-swap write.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openOauth, sealOauth } from "@/lib/server/crypto";
import { accessTokenFor, pullTwoDays } from "@/lib/server/oura";

const KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  vi.stubEnv("HEALTH_TOKEN_KEY", KEY);
  vi.stubEnv("OURA_CLIENT_ID", "cid");
  vi.stubEnv("OURA_CLIENT_SECRET", "secret");
  vi.stubEnv("OURA_REDIRECT_URI", "https://app.test/api/health/oura/callback");
});

const seal = (access: string, refresh: string, expiresAt = "2099-01-01T00:00:00Z") =>
  sealOauth({ access_token: access, refresh_token: refresh, expires_at: expiresAt,
    scope: "daily personal" }, Buffer.from(KEY, "base64"));

type Write = { data: unknown; error: unknown };

/** A health_sources row held in memory, with a CAS update whose result the test can script. */
function tokenStore(initial: string, writes: Array<Write | "apply"> = []) {
  const state = { oauth: initial as string | null, writes: 0 };
  const from = vi.fn((table: string) => {
    if (table === "user_settings") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () =>
        ({ data: { time_zone: "America/New_York" }, error: null }) }) }) };
    }
    return {
      select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () =>
        ({ data: state.oauth === null ? null : { oauth: state.oauth }, error: null }) }) }) }) }),
      update: (row: { oauth: string }) => ({ eq: () => ({ eq: (_c: string, expected: string) =>
        ({ select: async () => {
          const scripted = writes[state.writes];
          state.writes += 1;
          if (scripted && scripted !== "apply") return scripted;
          if (state.oauth !== expected) return { data: [], error: null };
          state.oauth = row.oauth;
          return { data: [{ id: "src" }], error: null };
        } }) }) }),
    };
  });
  return { admin: { from, rpc: vi.fn(async (name: string) => name === "health_ingest_event"
    ? { data: [{ id: "ev", is_new: true }], error: null }
    : { data: [{ accepted: 0, updated: 0, skipped: 0 }], error: null }) } as never, state };
}

const tokenResponse = (n: number) => new Response(JSON.stringify({ access_token: `at${n}`,
  refresh_token: `rt${n}`, expires_in: 86400, scope: "daily personal" }), { status: 200 });

describe("the 401 refresh", () => {
  it("refreshes a token Oura rejects while its stored expiry is still far off", async () => {
    const { admin, state } = tokenStore(seal("at0", "rt0"));
    let exchanges = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/oauth/token")) {
        exchanges += 1;
        expect(String(init?.body)).toContain("refresh_token=rt0");
        return tokenResponse(exchanges);
      }
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer at0" ? new Response("", { status: 401 })
        : new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const source = { id: "src", user_id: "u", oauth: state.oauth };
    await pullTwoDays(admin, source, "2026-09-15", { fetchFn });
    // Three parallel requests each saw a 401, and one exchange served all three.
    expect(exchanges).toBe(1);
    expect(openOauth(state.oauth!).refresh_token).toBe("rt1");
  });

  it("uses the pair another worker stored instead of spending a refresh token twice", async () => {
    const { admin, state } = tokenStore(seal("at0", "rt0"));
    const stale = state.oauth!;
    state.oauth = seal("fresh", "rt9");
    const fetchFn = vi.fn();
    const token = await accessTokenFor(admin, { id: "src", user_id: "u", oauth: stale },
      { fetchFn, force: true });
    expect(token).toBe("fresh");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("the rotated-token write", () => {
  it("is checked: a swap that matches no row reads the winner's pair", async () => {
    const winner = seal("winner", "rtw");
    const { admin, state } = tokenStore(seal("at0", "rt0", "2026-09-15T14:01:00Z"), [
      { data: [], error: null }]);
    const source = { id: "src", user_id: "u", oauth: state.oauth };
    state.oauth = winner;
    const fetchFn = vi.fn(async () => tokenResponse(1));
    const token = await accessTokenFor(admin, source,
      { fetchFn, now: new Date("2026-09-15T14:00:00Z") });
    expect(token).toBe("winner");
  });

  it("retries a failed write once and then fails loudly, never returning an unsaved pair", async () => {
    const failure = { data: null, error: { message: "boom" } };
    const { admin, state } = tokenStore(seal("at0", "rt0"), [failure, failure]);
    const source = { id: "src", user_id: "u", oauth: state.oauth };
    const fetchFn = vi.fn(async () => tokenResponse(1));
    await expect(accessTokenFor(admin, source, { fetchFn, force: true }))
      .rejects.toMatchObject({ status: 500, code: "token_store_failed" });
    expect(state.writes).toBe(2);
  });

  it("stores the pair on the retry after one failed write", async () => {
    const { admin, state } = tokenStore(seal("at0", "rt0"),
      [{ data: null, error: { message: "boom" } }, "apply"]);
    const source = { id: "src", user_id: "u", oauth: state.oauth };
    const fetchFn = vi.fn(async () => tokenResponse(1));
    expect(await accessTokenFor(admin, source, { fetchFn, force: true })).toBe("at1");
    expect(openOauth(state.oauth!).refresh_token).toBe("rt1");
  });
});
