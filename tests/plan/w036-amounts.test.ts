import { describe, expect, it } from "vitest";
import { capExcludeIds, MAX_EXCLUDE_IDS } from "@/lib/plan/chips";
import { cleanDays, parseAmount } from "@/lib/plan/document-clean";

describe("amount parsing (W036)", () => {
  it("reads a lone fraction", () => expect(parseAmount("½")).toEqual({ count: 0.5 }));
  it("reads a mixed fraction", () => expect(parseAmount("1 ½")).toEqual({ count: 1.5 }));
  it("reads a can with its size", () => {
    expect(parseAmount("1 (15 oz) can")).toEqual({ grams: 425 });
    expect(parseAmount("2 (15 oz) cans")).toEqual({ grams: 851 });
  });
});

describe("unreadable amounts (W036)", () => {
  const read = (amount: string | null) => cleanDays([{ label: "Mon", meals: [{ name: "Lunch", time: null,
    foods: [{ name: "rice", amount }] }] }])[0].meals[0].foods[0];
  it("marks a written but unreadable amount", () => {
    expect(read("a big old pile of it, roughly")).toMatchObject({ amount: null, amountUnreadable: true });
    expect(read("lots")).toMatchObject({ amountUnreadable: true });
  });
  it("leaves a missing amount as one portion", () => {
    expect(read(null)).toEqual({ name: "rice", amount: null });
    expect(read("150 g")).toEqual({ name: "rice", amount: "150 g" });
  });
});

describe("Not-this list cap (W036)", () => {
  it("keeps 100 ids under the 2 KB body", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `food:${"x".repeat(60)}-${i}`);
    const kept = capExcludeIds(ids);
    expect(kept.length).toBeLessThanOrEqual(MAX_EXCLUDE_IDS);
    expect(kept.at(-1)).toBe(ids.at(-1));
    const body = JSON.stringify({ chip: "choose", slot: "meal-1", date: "2026-10-17", zone: "America/Los_Angeles", excludeIds: kept });
    expect(Buffer.byteLength(body)).toBeLessThan(2048);
  });
});

describe("package sizes that cannot be read (W036 review)", () => {
  it("returns null, never one portion", () => {
    for (const text of ["1 (400 ml) can", "1 (12 fl oz) can", "500 (500 g) cans"]) expect(parseAmount(text), text).toBeNull();
  });
});
