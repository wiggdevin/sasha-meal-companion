import { describe, expect, it } from "vitest";
import { accountClock, clockIn } from "@/lib/server/day-context";

describe("her clock", () => {
  it("takes the local date from the body's tz, not the server's", () => {
    // 03:30 UTC on the 15th is still the 14th in Denver.
    const clock = accountClock(
      { threadId: null, messageId: "m", text: "hi", now: "2026-09-15T03:30:00.000Z",
        tz: "America/Denver" },
      Date.parse("2026-09-15T03:30:00.000Z"));
    expect(clock.date).toBe("2026-09-14");
    expect(clock.tz).toBe("America/Denver");
  });

  it("falls back to the default tz and the server clock when the body carries neither", () => {
    const clock = accountClock({ threadId: null, messageId: "m", text: "hi" },
      Date.parse("2026-09-15T18:00:00.000Z"));
    expect(clock.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(clock.tz.length).toBeGreaterThan(0);
  });

  it("reports an entry's time on her clock", () => {
    expect(clockIn("2026-09-15T15:00:00.000Z", "America/Denver")).toBe("09:00");
  });
});
