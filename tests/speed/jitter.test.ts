/**
 * Scale S1: client retries are jittered, so phones that failed in the same outage do not all come
 * back on the same second (lib/jitter.ts). The outbox's own cases live in lib/sync/outbox.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { equalJitter } from "@/lib/jitter";
import { RECIPE_RETRY_MS, RecipeReader } from "@/lib/recipes/recipe-freshness";

describe("equalJitter", () => {
  it("keeps half the delay and draws the other half", () => {
    expect([0, 0.25, 0.5, 1].map((r) => equalJitter(8_000, () => r))).toEqual([4_000, 5_000, 6_000, 8_000]);
  });

  it("never goes past the planned delay or under half of it, whatever the source returns", () => {
    expect(equalJitter(8_000, () => 7)).toBe(8_000);
    expect(equalJitter(8_000, () => -3)).toBe(4_000);
    expect(equalJitter(8_000, () => Number.NaN)).toBe(8_000);
  });

  it("is zero for no delay", () => {
    expect(equalJitter(0)).toBe(0);
    expect(equalJitter(-5)).toBe(0);
  });

  it("spreads a herd: a thousand draws are not one number", () => {
    const draws = new Set(Array.from({ length: 1_000 }, () => equalJitter(60_000)));
    expect(draws.size).toBeGreaterThan(100);
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(30_000);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });
});

describe("a recipe re-read that failed", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("retries inside the jitter band, not on the planned second", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const load = vi.fn(async () => { throw new Error("outage"); });
    const reader = new RecipeReader<number>({
      apply: () => {}, judged: () => true, setStale: () => {}, retryAsks: true, random: () => 0,
    });
    await reader.read(load);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECIPE_RETRY_MS[0] / 2 - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    reader.clear();
  });
});
