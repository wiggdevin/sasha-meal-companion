import { describe, expect, it } from "vitest";
import { rateLimitKey } from "@/lib/server/capture-rate-limit";

// Finding #56: the pre-identity rate limit here keyed off the first hop of
// `x-forwarded-for`, a header a caller can set to anything. Vercel appends
// the real client address rather than replacing it, so a spoofed value
// always wins `.split(",")[0]`, letting an attacker rotate past
// enforceRateLimit for free. `x-real-ip` is the header Vercel itself sets
// and a client cannot override (see app/auth/callback/route.ts's own key).
describe("rateLimitKey", () => {
  it("does not change when a caller spoofs x-forwarded-for", () => {
    const a = new Request("http://test/api/log/propose", {
      headers: { "x-forwarded-for": "1.1.1.1", "x-real-ip": "9.9.9.9" },
    });
    const b = new Request("http://test/api/log/propose", {
      headers: { "x-forwarded-for": "2.2.2.2", "x-real-ip": "9.9.9.9" },
    });

    expect(rateLimitKey(a)).toBe(rateLimitKey(b));
  });

  it("keys on the trusted x-real-ip header", () => {
    const req = new Request("http://test/api/log/propose", {
      headers: { "x-real-ip": "9.9.9.9" },
    });

    expect(rateLimitKey(req)).toBe("log:propose:ip:9.9.9.9");
  });

  it("gives each route its own bucket (scale S2)", () => {
    const req = new Request("http://test/api/plan/inspire", { headers: { "x-real-ip": "9.9.9.9" } });
    expect(rateLimitKey(req, "plan:inspire")).toBe("plan:inspire:ip:9.9.9.9");
    expect(rateLimitKey(req, "plan:document")).not.toBe(rateLimitKey(req));
  });
});
