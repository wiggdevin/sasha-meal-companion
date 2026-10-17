/**
 * Audit A166: a retime into the spring-forward gap moves the same way in every zone (the
 * JavaScript/Temporal "compatible" rule), and a repeated autumn time is its earlier instant.
 */
import { describe, expect, it } from "vitest";
import { instantAt } from "@/lib/coach/apply-shared";

const iso = (date: string, time: string, tz: string) => instantAt(date, time, tz)?.toISOString();

describe("instantAt across daylight-saving changes", () => {
  it("moves a time in the spring-forward gap an hour later, west of UTC", () => {
    // Los Angeles skips 02:00–03:00 on 2026-03-08; 02:30 is read as 03:30 PDT.
    expect(iso("2026-03-08", "02:30", "America/Los_Angeles")).toBe("2026-03-08T10:30:00.000Z");
  });

  it("moves a time in the spring-forward gap an hour later, east of UTC", () => {
    // Auckland skips 02:00–03:00 on 2026-09-27; 02:30 is read as 03:30 NZDT.
    expect(iso("2026-09-27", "02:30", "Pacific/Auckland")).toBe("2026-09-26T14:30:00.000Z");
  });

  it("keeps the times either side of the gap exact", () => {
    expect(iso("2026-03-08", "01:30", "America/Los_Angeles")).toBe("2026-03-08T09:30:00.000Z");
    expect(iso("2026-03-08", "03:30", "America/Los_Angeles")).toBe("2026-03-08T10:30:00.000Z");
  });

  it("reads a repeated fall-back time as its earlier instant", () => {
    // Los Angeles repeats 01:00–02:00 on 2026-11-01; 01:30 PDT comes first.
    expect(iso("2026-11-01", "01:30", "America/Los_Angeles")).toBe("2026-11-01T08:30:00.000Z");
  });

  it("is plain on an ordinary day and refuses an unknown zone", () => {
    expect(iso("2026-10-10", "12:00", "America/Denver")).toBe("2026-10-10T18:00:00.000Z");
    expect(iso("2026-10-10", "12:00", "Not/AZone")).toBeUndefined();
  });
});
