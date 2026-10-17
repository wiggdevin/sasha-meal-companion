import { describe, expect, it } from "vitest";
import { isCalendarDate, parseLimit, parseUuid } from "@/lib/server/validate";
import { dailyQuerySchema } from "@/lib/health/contract";

describe("shared input parsers (W069)", () => {
  it("accepts only real calendar dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-13-45", "2026-02-31", "2026-2-1", "abc", ""]) {
      expect(isCalendarDate(bad)).toBe(false);
    }
    expect(dailyQuerySchema.safeParse({ from: "2026-13-45", to: "2026-01-01" }).success).toBe(false);
  });

  it("parses uuids and answers 400 for anything else", () => {
    const id = "5f1b1a2c-0000-4000-8000-0000000000a1";
    expect(parseUuid(id)).toBe(id);
    expect(() => parseUuid("pr1")).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("parses whole-number limits and answers 400 for abc and 2.5", () => {
    const o = { max: 50, fallback: 50 };
    expect(parseLimit(null, o)).toBe(50);
    expect(parseLimit("7", o)).toBe(7);
    for (const bad of ["abc", "2.5", "0", "51", "-1", ""]) {
      expect(() => parseLimit(bad, o)).toThrowError(expect.objectContaining({ status: 400 }));
    }
  });
});
