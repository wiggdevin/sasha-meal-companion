import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDate } from "@/lib/coach/chat-state";

// 19:30 on 2026-10-05 in Denver is 01:30 on 2026-10-06 in UTC.
const EVENING = new Date("2026-10-06T01:30:00.000Z");

describe("chat-state localDate", () => {
  let savedTz: string | undefined;
  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "America/Denver";
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("reads the date in a valid zone", () => {
    expect(localDate("America/Denver", EVENING)).toBe("2026-10-05");
    expect(localDate("UTC", EVENING)).toBe("2026-10-06");
  });

  it("falls back to the device's local day, not the UTC date, for an unknown zone", () => {
    expect(localDate("Not/AZone", EVENING)).toBe("2026-10-05");
  });
});
