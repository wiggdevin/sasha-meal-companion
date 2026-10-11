import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

const completeOura = vi.fn(async () => ({ sourceId: "source-a", userId: "user-a" }));
vi.mock("@/lib/server/oura", () => ({ completeOura: (...args: unknown[]) => completeOura(...(args as [])),
  pullTwoDays: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ from: () => ({
  select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
}) }) }));

const { GET } = await import("@/app/api/health/oura/callback/route");
const state = `nonce.${Buffer.from("/body?tab=sleep").toString("base64url")}`;

beforeEach(() => {
  resetRateLimits();
  completeOura.mockClear();
  vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
});

describe("Oura callback return", () => {
  it("returns to the state-bound same-origin path after connection", async () => {
    const res = await GET(new Request(`https://app.test/api/health/oura/callback?state=${state}&code=ok`));
    expect(res.headers.get("location")).toBe("https://app.test/body?tab=sleep&oura=connected");
    expect(completeOura).toHaveBeenCalledTimes(1);
  });

  it("reports denial on the safe path and never exchanges a code", async () => {
    const res = await GET(new Request(`https://app.test/api/health/oura/callback?state=${state}&error=access_denied`));
    expect(res.headers.get("location")).toBe("https://app.test/body?tab=sleep&oura=error&reason=denied");
    expect(completeOura).not.toHaveBeenCalled();
  });

  it("falls back to Settings for an external path embedded in state", async () => {
    const unsafe = `nonce.${Buffer.from("https://evil.test/").toString("base64url")}`;
    const res = await GET(new Request(`https://app.test/api/health/oura/callback?state=${unsafe}&error=access_denied`));
    expect(res.headers.get("location")).toBe("https://app.test/settings?oura=error&reason=denied");
  });

  it("does not follow a dot-segment path to another host (A053)", async () => {
    const unsafe = `x.${Buffer.from("/.//evil.example/p").toString("base64url")}`;
    const res = await GET(new Request(`https://app.test/api/health/oura/callback?error=1&state=${unsafe}`));
    expect(res.headers.get("location")).toBe("https://app.test/settings?oura=error&reason=denied");
  });
});
