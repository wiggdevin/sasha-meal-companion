/**
 * W125: when a plate photo's meal was eaten. The photo's own time wins on the capture's day; a
 * photo from another day, or one ahead of now, keeps the capture's usual time.
 */
import { describe, expect, it } from "vitest";
import { atClock, clockIn, photoEatenAt } from "@/lib/capture/shot-time";

const ctx = { localDate: "2026-10-17", tz: "America/Los_Angeles", now: new Date("2026-10-17T20:00:00Z") };

describe("photoEatenAt", () => {
  it("prefers the Exif time, then the moment the file was picked", () => {
    const exif = new Date("2026-10-17T15:15:00Z");
    const picked = new Date("2026-10-17T19:55:00Z");
    expect(photoEatenAt({ exif, picked }, ctx)).toEqual({ at: exif, source: "photo" });
    expect(photoEatenAt({ exif: null, picked }, ctx)).toEqual({ at: picked, source: "picked" });
  });

  it("skips a time on another day in the capture's zone, or ahead of now", () => {
    const yesterday = new Date("2026-10-17T05:00:00Z"); // 22:00 on the 16th in Los Angeles
    const later = new Date("2026-10-17T21:00:00Z");
    expect(photoEatenAt({ exif: yesterday, picked: later }, ctx)).toBeNull();
    expect(photoEatenAt({ exif: new Date("2026-10-17T20:03:00Z"), picked: null }, ctx)?.source).toBe("photo");
  });
});

describe("the time control", () => {
  it("shows the clock in the capture's zone and turns an edit back into that day's instant", () => {
    const at = new Date("2026-10-17T15:15:00Z");
    expect(clockIn(at, ctx.tz)).toBe("08:15");
    expect(atClock("2026-10-17", "08:15", ctx.tz)?.toISOString()).toBe(at.toISOString());
  });

  it("lands on the right instant on a daylight-saving day", () => {
    // 2026-11-01: Los Angeles falls back at 02:00; 09:30 is PST (UTC-8).
    expect(atClock("2026-11-01", "09:30", ctx.tz)?.toISOString()).toBe("2026-11-01T17:30:00.000Z");
    expect(atClock("2026-03-08", "12:00", ctx.tz)?.toISOString()).toBe("2026-03-08T19:00:00.000Z");
  });

  it("refuses a malformed clock", () => {
    expect(atClock("2026-10-17", "25:00", ctx.tz)).toBeNull();
    expect(atClock("2026-10-17", "", ctx.tz)).toBeNull();
  });
});
