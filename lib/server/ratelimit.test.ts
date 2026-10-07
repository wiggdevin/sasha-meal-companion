import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enforceRateLimit, resetRateLimits } from "./ratelimit";

describe("enforceRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRateLimits();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows exactly the limit inside one window", async () => {
    for (let i = 0; i < 3; i += 1) await enforceRateLimit("mcp:t1", 3, 60);
    await expect(enforceRateLimit("mcp:t1", 3, 60)).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });

  it("starts a fresh window once the old one expires", async () => {
    for (let i = 0; i < 3; i += 1) await enforceRateLimit("mcp:t1", 3, 60);
    vi.advanceTimersByTime(60_000);
    await expect(enforceRateLimit("mcp:t1", 3, 60)).resolves.toBeUndefined();
  });

  it("counts each key on its own", async () => {
    for (let i = 0; i < 3; i += 1) await enforceRateLimit("mcp:t1", 3, 60);
    await expect(enforceRateLimit("mcp:t2", 3, 60)).resolves.toBeUndefined();
  });

  it("says how long the caller must wait", async () => {
    await enforceRateLimit("mcp:t3", 1, 60);
    await expect(enforceRateLimit("mcp:t3", 1, 60)).rejects.toThrow(/60 s/);
  });
});
