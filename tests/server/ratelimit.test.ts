/**
 * Scale S2: the shared limiter's policy (lib/server/ratelimit.ts) with an injected store. The
 * database store itself is proven on the local stack (tests/migrations/rate-limits-db.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FAILURE_POLICY, dbRateLimitStore, enforceRateLimit, resetRateLimits, setRateLimitStore,
  type RateLimitStore,
} from "@/lib/server/ratelimit";
import { jsonError } from "@/lib/server/http";
import { requestIp } from "@/lib/server/request-ip";

afterEach(() => {
  setRateLimitStore(null);
  resetRateLimits();
  vi.restoreAllMocks();
});

function counting(limit: number): RateLimitStore & { hits: number } {
  let count = 0;
  const store = {
    hits: 0,
    async hit() {
      store.hits += 1;
      count += 1;
      return { allowed: count <= limit, remaining: Math.max(limit - count, 0), resetAt: Date.now() + 30_000 };
    },
  };
  return store;
}

const failing: RateLimitStore = { hit: async () => { throw new Error("db down"); } };

describe("enforceRateLimit", () => {
  it("asks the store for every allowed request", async () => {
    const store = counting(3);
    setRateLimitStore(store);
    for (let i = 0; i < 3; i++) await enforceRateLimit("k", 3, 60);
    expect(store.hits).toBe(3);
  });

  it("short-circuits only a key the store already refused, until its window resets", async () => {
    const store = counting(1);
    setRateLimitStore(store);
    await enforceRateLimit("k", 1, 60);
    await expect(enforceRateLimit("k", 1, 60)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await expect(enforceRateLimit("k", 1, 60)).rejects.toMatchObject({ status: 429 });
    expect(store.hits).toBe(2);
    await enforceRateLimit("other", 1, 60).catch(() => undefined);
    expect(store.hits).toBe(3);
  });

  it("fails closed by default: 503 with a Retry-After hint", async () => {
    expect(DEFAULT_FAILURE_POLICY).toBe("fail_closed");
    setRateLimitStore(failing);
    const error = await enforceRateLimit("k", 5, 60).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, code: "rate_limit_unavailable", retryAfterSeconds: 5 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = jsonError(error);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("fails open only when asked, with a logged warning", async () => {
    setRateLimitStore(failing);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(enforceRateLimit("reads:u1", 5, 60, "fail_open")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fail open"), expect.objectContaining({
      key_prefix: "reads" }));
  });

  it("a 429 carries Retry-After too", async () => {
    setRateLimitStore(counting(0));
    const res = jsonError(await enforceRateLimit("k", 1, 60).catch((e: unknown) => e));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("dbRateLimitStore", () => {
  it("calls rate_limit_hit once and reads its row", async () => {
    const rpc = vi.fn(async () => ({ data: [{ allowed: true, remaining: 4,
      reset_at: "2030-01-01T00:01:00+00:00" }], error: null }));
    const store = dbRateLimitStore(() => ({ rpc }) as never);
    await expect(store.hit("k", 5, 60)).resolves.toEqual({ allowed: true, remaining: 4,
      resetAt: Date.parse("2030-01-01T00:01:00Z") });
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", { p_key: "k", p_limit: 5, p_window_seconds: 60 });
  });

  it("treats an error or a malformed row as a failure (the policy then decides)", async () => {
    const errored = dbRateLimitStore(() => ({ rpc: async () => ({ data: null, error: { message: "x" } }) }) as never);
    await expect(errored.hit("k", 5, 60)).rejects.toThrow();
    const malformed = dbRateLimitStore(() => ({ rpc: async () => ({ data: [{}], error: null }) }) as never);
    await expect(malformed.hit("k", 5, 60)).rejects.toThrow();
  });
});

describe("requestIp", () => {
  it("trusts only Vercel's x-real-ip, never a caller-set x-forwarded-for", () => {
    const req = new Request("http://t", { headers: { "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" } });
    expect(requestIp(req)).toBe("9.9.9.9");
    expect(requestIp(new Request("http://t", { headers: { "x-forwarded-for": "1.1.1.1" } }))).toBe("unknown");
    expect(requestIp(new Request("http://t"))).toBe("unknown");
  });
});
