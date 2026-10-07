import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { GET } from "./route";

function get(ip: string): Request {
  return new Request("https://app.test/api/health/oura/callback", {
    headers: { "x-real-ip": ip },
  });
}

function reasonOf(res: Response): string | null {
  return new URL(res.headers.get("location")!).searchParams.get("reason");
}

describe("GET /api/health/oura/callback rate limiting", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
  });

  it("does not let one caller's requests exhaust the bucket for a different caller", async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await GET(get("203.0.113.1"));
      expect(reasonOf(res)).toBe("bad_state");
    }
    const res = await GET(get("198.51.100.9"));
    expect(reasonOf(res)).toBe("bad_state");
  });
});
