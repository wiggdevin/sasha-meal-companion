import { describe, expect, it } from "vitest";
import { renderReport, scoreMethod } from "@/scripts/ai-eval";

const result = (label: string, grams: number, expected: string, expectedGrams: number,
  autoResolved: boolean, inTop3: boolean) => ({
  expected: { label: expected, grams: expectedGrams }, got: { label, grams }, autoResolved, inTop3 });

describe("scoreMethod", () => {
  it("scores item accuracy and mean absolute gram error", () => {
    const s = scoreMethod("text", [
      result("egg", 100, "egg", 90, false, true),
      result("rice", 150, "pasta", 150, false, false),
    ]);
    expect(s.n).toBe(2);
    expect(s.itemAccuracy).toBe(0.5);
    expect(s.gramMae).toBe(5);
    expect(s.top3Containment).toBe(0.5);
  });

  it("reports a null precision when nothing auto-resolved", () => {
    const s = scoreMethod("text", [result("egg", 100, "egg", 100, false, true)]);
    expect(s.autoResolved).toBe(0);
    expect(s.autoResolvePrecision).toBeNull();
  });

  it("reports precision over auto-resolved items only", () => {
    const s = scoreMethod("text", [
      result("egg", 100, "egg", 100, true, true),
      result("rice", 100, "pasta", 100, true, false),
      result("oat", 100, "oat", 100, false, true),
    ]);
    expect(s.autoResolved).toBe(2);
    expect(s.autoResolvePrecision).toBe(0.5);
  });

  it("counts a failed provider call as a miss, not a dropped item", () => {
    const s = scoreMethod("text", [
      result("egg", 100, "egg", 100, false, true),
      { expected: { label: "rice", grams: 100 }, got: null, autoResolved: false, inTop3: false },
    ]);
    expect(s.n).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.itemAccuracy).toBe(0.5);
    expect(s.top3Containment).toBe(0.5);
    expect(s.gramMae).toBe(0);
  });
});

describe("renderReport", () => {
  it("prints the vacuous-precision line instead of a percentage", () => {
    const md = renderReport([scoreMethod("text", [result("egg", 100, "egg", 100, false, true)])],
      "2026-09-20");
    expect(md).toContain("0 auto-resolved of 1");
    expect(md).toContain("top-3 containment");
    expect(md).not.toMatch(/auto-resolve precision\s*\|\s*100/);
  });
});
