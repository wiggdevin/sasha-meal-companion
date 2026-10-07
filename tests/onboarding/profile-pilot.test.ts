/** Phase 18 D2 / W15: the onboarding cuisine question stays closed until W15 assigns arms. */
import { describe, expect, it, vi } from "vitest";
import { profilePilotEnabled } from "@/lib/server/profile-pilot";

const USER = "11111111-1111-4111-8111-111111111111";

describe("profilePilotEnabled", () => {
  it("is closed for every account before W15", () => {
    expect(profilePilotEnabled(USER)).toBe(false);
  });
});

describe("GET /api/onboarding/profile-pilot", () => {
  it("answers { enabled: false } for the session user, private and uncached", async () => {
    vi.resetModules();
    vi.doMock("@/lib/server/auth", async (orig) => ({
      ...(await orig<typeof import("@/lib/server/auth")>()),
      requireUser: vi.fn(async () => ({ client: {}, userId: USER })),
    }));
    const { GET } = await import("@/app/api/onboarding/profile-pilot/route");
    const res = await GET(new Request("http://test/api/onboarding/profile-pilot"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    vi.doUnmock("@/lib/server/auth");
  });
});
