/** Phase 19 §6.2 / R2: the rebalance panel gate is closed by default, everywhere. */
import { describe, expect, it } from "vitest";
import { rebalanceAccessEnabled } from "@/lib/server/rebalance-access";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("rebalanceAccessEnabled", () => {
  it("is off with an empty or missing allowlist, with no development or localhost fallback", () => {
    expect(rebalanceAccessEnabled(USER, {})).toBe(false);
    expect(rebalanceAccessEnabled(USER, { REBALANCE_PANEL_USER_IDS: "" })).toBe(false);
    expect(rebalanceAccessEnabled(USER, { REBALANCE_PANEL_USER_IDS: " , " })).toBe(false);
    expect(rebalanceAccessEnabled(USER, { REBALANCE_PANEL_USER_IDS: "",
      NODE_ENV: "development", SUPABASE_URL: "http://127.0.0.1:54321" })).toBe(false);
  });

  it("is on for a listed account or '*', and off for anyone else", () => {
    expect(rebalanceAccessEnabled(USER, { REBALANCE_PANEL_USER_IDS: `${OTHER}, ${USER}` })).toBe(true);
    expect(rebalanceAccessEnabled(OTHER, { REBALANCE_PANEL_USER_IDS: USER })).toBe(false);
    expect(rebalanceAccessEnabled(USER, { REBALANCE_PANEL_USER_IDS: "*" })).toBe(true);
  });
});

describe("GET /api/rebalance/access", () => {
  it("answers { enabled } for the session user, private and uncached", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("@/lib/server/auth", async (orig) => ({
      ...(await orig<typeof import("@/lib/server/auth")>()),
      requireUser: vi.fn(async () => ({ client: {}, userId: USER })),
    }));
    const prior = process.env.REBALANCE_PANEL_USER_IDS;
    try {
      process.env.REBALANCE_PANEL_USER_IDS = USER;
      const { GET } = await import("@/app/api/rebalance/access/route");
      const res = await GET(new Request("http://test/api/rebalance/access"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true });
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      delete process.env.REBALANCE_PANEL_USER_IDS;
      expect(await (await GET(new Request("http://test/api/rebalance/access"))).json())
        .toEqual({ enabled: false });
    } finally {
      if (prior === undefined) delete process.env.REBALANCE_PANEL_USER_IDS;
      else process.env.REBALANCE_PANEL_USER_IDS = prior;
      vi.doUnmock("@/lib/server/auth");
    }
  });
});
