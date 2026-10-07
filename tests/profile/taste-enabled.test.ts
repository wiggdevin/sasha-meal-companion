/**
 * Phase 18 W5b-3: the phone can tell "taste chips are off" from "the request failed".
 * - `GET /api/profile/taste/enabled` answers `TASTE_CHIPS_ENABLED`, auth required, no-store.
 * - `readTasteChipsEnabled` maps it to enabled | disabled | unknown.
 * - `requestTasteChips` separates 404 `not_enabled` (disabled) from every other failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ fetch: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => ({ userId: "account-a", epoch: 1 }),
  accountFetch: (_h: unknown, url: string, init: RequestInit) => mocked.fetch(url, init),
  accountJson: async (_h: unknown, response: Response) => response.json(),
  rethrowAccountChanged: () => undefined,
}));
vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  requireUser: mocked.requireUser,
}));

import { HttpError } from "@/lib/server/auth";
import { GET } from "@/app/api/profile/taste/enabled/route";
import { readTasteChipsEnabled, TASTE_ENABLED_PATH } from "@/lib/profile/taste-enabled-client";
import { requestTasteChips, suggestTasteChips } from "@/lib/profile/prefs-client";

const USER = "11111111-1111-4111-8111-111111111111";
const probe = () => GET(new Request("http://test/api/profile/taste/enabled"));

beforeEach(() => {
  mocked.fetch.mockReset();
  mocked.requireUser.mockReset().mockResolvedValue({ client: {}, userId: USER });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("GET /api/profile/taste/enabled", () => {
  it("answers the switch for the session user, private and uncached", async () => {
    vi.stubEnv("TASTE_CHIPS_ENABLED", "");
    let res = await probe();
    expect([res.status, await res.json(), res.headers.get("Cache-Control")]).toEqual([200, { enabled: false }, "private, no-store"]);
    vi.stubEnv("TASTE_CHIPS_ENABLED", "1");
    res = await probe();
    expect([res.status, await res.json()]).toEqual([200, { enabled: true }]);
  });

  it("requires a session: 401, uncached", async () => {
    vi.stubEnv("TASTE_CHIPS_ENABLED", "1");
    mocked.requireUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    const res = await probe();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("readTasteChipsEnabled", () => {
  it("reads 200 { enabled } as enabled or disabled, without caching", async () => {
    mocked.fetch.mockResolvedValueOnce(Response.json({ enabled: true }));
    expect(await readTasteChipsEnabled()).toBe("enabled");
    mocked.fetch.mockResolvedValueOnce(Response.json({ enabled: false }));
    expect(await readTasteChipsEnabled()).toBe("disabled");
    expect(mocked.fetch).toHaveBeenCalledWith(TASTE_ENABLED_PATH, expect.objectContaining({ cache: "no-store" }));
  });

  it("is unknown for anything else: offline, 401, 404, 5xx, another shape", async () => {
    mocked.fetch.mockRejectedValueOnce(new Error("offline"));
    expect(await readTasteChipsEnabled()).toBe("unknown");
    for (const res of [new Response("", { status: 401 }), new Response("", { status: 404 }),
      new Response("", { status: 503 }), Response.json({ enabled: "yes" }), Response.json(null),
      new Response("<html>", { status: 200 })]) {
      mocked.fetch.mockResolvedValueOnce(res);
      expect(await readTasteChipsEnabled()).toBe("unknown");
    }
  });
});

describe("requestTasteChips", () => {
  const chips = { route: "send", jev: true, likes: [], dislikes: [{ key: "t:bitter", label: "Bitter flavors", p: 0.9 }], cuisines: [] };

  it("answers the server's chips", async () => {
    mocked.fetch.mockResolvedValue(Response.json(chips));
    expect(await requestTasteChips("I hate bitter food")).toEqual({ ok: true, suggestion: chips });
  });

  it("answers kept text locally with no request", async () => {
    expect(await requestTasteChips("I am allergic to peanuts")).toMatchObject({ ok: true, suggestion: { route: "local" } });
    expect(mocked.fetch).not.toHaveBeenCalled();
  });

  it("is disabled only for the route's 404 not_enabled", async () => {
    mocked.fetch.mockResolvedValueOnce(Response.json({ error: "not_enabled", message: "x" }, { status: 404 }));
    expect(await requestTasteChips("I love salmon")).toEqual({ ok: false, reason: "disabled" });
    mocked.fetch.mockResolvedValueOnce(new Response("<html>not found</html>", { status: 404 }));
    expect(await requestTasteChips("I love salmon")).toEqual({ ok: false, reason: "failed", status: 404 });
    mocked.fetch.mockResolvedValueOnce(Response.json({ error: "not_found" }, { status: 404 }));
    expect(await requestTasteChips("I love salmon")).toEqual({ ok: false, reason: "failed", status: 404 });
  });

  it("is failed for a network error, 429, 5xx or another shape", async () => {
    mocked.fetch.mockRejectedValueOnce(new Error("offline"));
    expect(await requestTasteChips("I love salmon")).toEqual({ ok: false, reason: "failed" });
    mocked.fetch.mockResolvedValueOnce(Response.json({ error: "rate_limited" }, { status: 429 }));
    expect(await requestTasteChips("I love salmon")).toEqual({ ok: false, reason: "failed", status: 429 });
    mocked.fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(await requestTasteChips("I love salmon")).toEqual({ ok: false, reason: "failed", status: 503 });
    for (const body of [{ route: "send" }, { ...chips, likes: [null] }, { ...chips, cuisines: [{ key: "x", label: "X", p: 2 }] },
      { route: "local", reason: "other", offer: "rule_editor" }]) {
      mocked.fetch.mockResolvedValueOnce(Response.json(body));
      expect(await requestTasteChips("I love salmon")).toEqual({ ok: false, reason: "failed", status: 200 });
    }
  });

  it("suggestTasteChips keeps its W5b shape: null for disabled and failed alike", async () => {
    mocked.fetch.mockResolvedValueOnce(Response.json({ error: "not_enabled" }, { status: 404 }));
    expect(await suggestTasteChips("I love salmon")).toBeNull();
    mocked.fetch.mockResolvedValueOnce(Response.json(chips));
    expect(await suggestTasteChips("I love salmon")).toEqual(chips);
  });
});
