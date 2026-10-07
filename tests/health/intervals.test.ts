import { describe, expect, it } from "vitest";
import { unionNonOverlapping, type Interval } from "@/lib/health/intervals";

const iv = (start: number, end: number, value: number, preferred = false): Interval =>
  ({ start, end, value, preferred });

describe("unionNonOverlapping", () => {
  it("is 0 for no intervals", () => {
    expect(unionNonOverlapping([])).toBe(0);
  });

  it("sums disjoint intervals in full", () => {
    expect(unionNonOverlapping([iv(0, 100, 10), iv(200, 300, 20)])).toBe(30);
  });

  it("does not double-count adjacent intervals", () => {
    expect(unionNonOverlapping([iv(0, 100, 10), iv(100, 200, 20)])).toBe(30);
  });

  it("lets the preferred source claim the overlap whatever the order", () => {
    // Watch 0–100 = 1000 steps, phone 50–150 = 600 steps. The phone keeps its uncovered half.
    expect(unionNonOverlapping([iv(50, 150, 600), iv(0, 100, 1000, true)])).toBe(1300);
    expect(unionNonOverlapping([iv(0, 100, 1000, true), iv(50, 150, 600)])).toBe(1300);
  });

  it("drops a non-preferred interval entirely covered by a preferred one", () => {
    expect(unionNonOverlapping([iv(0, 200, 2000, true), iv(50, 150, 900)])).toBe(2000);
  });

  it("counts an instantaneous sample once and never twice", () => {
    expect(unionNonOverlapping([iv(500, 500, 7), iv(500, 500, 7)])).toBe(7);
  });

  it("ignores an instantaneous sample already inside a claimed range", () => {
    expect(unionNonOverlapping([iv(0, 100, 10, true), iv(50, 50, 99)])).toBe(10);
  });

  it("tolerates a reversed interval by normalising its ends", () => {
    expect(unionNonOverlapping([iv(100, 0, 10)])).toBe(10);
  });
});
