import { afterEach, describe, expect, it, vi } from "vitest";

const { todayIso } = await import("@/lib/server/jobs");

describe("todayIso", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("uses UTC when the account has no saved timezone", () => {
    vi.stubEnv("TZ", "UTC");
    const now = new Date("2026-09-13T01:00:00.000Z");
    expect(todayIso(now)).toBe("2026-09-13");
  });
});
