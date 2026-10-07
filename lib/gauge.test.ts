import { describe, expect, it } from "vitest";
import { arc, excessProgress, ticks, tracer } from "./gauge";

describe("arc — progress ring dasharray/dashoffset", () => {
  it("arc(124, 0.42): circumference and dashoffset at 42%", () => {
    const result = arc(124, 0.42);
    expect(result.circumference).toBeCloseTo(779.1, 1);
    expect(result.dashoffset).toBeCloseTo(451.9, 1);
  });

  it("clamps pct > 1 to a dashoffset of 0 (full ring drawn)", () => {
    const result = arc(124, 1.5);
    expect(result.dashoffset).toBeCloseTo(0, 5);
  });

  it("clamps pct < 0 to a dashoffset equal to the circumference (nothing drawn)", () => {
    const result = arc(124, -0.5);
    expect(result.dashoffset).toBeCloseTo(result.circumference, 5);
  });
});

describe("excessProgress", () => {
  it("starts an excess lap after the target and caps it after one extra lap", () => {
    expect(excessProgress(70, 70)).toBe(0);
    expect(excessProgress(120, 70)).toBeCloseTo(50 / 70);
    expect(excessProgress(210, 70)).toBe(1);
    expect(excessProgress(1000, 70)).toBe(1);
    expect(excessProgress(10, 0)).toBe(0);
  });
});

describe("tracer — dot position on the ring", () => {
  it("tracer(150,150,124,0) sits at 12 o'clock", () => {
    const result = tracer(150, 150, 124, 0);
    expect(result.x).toBeCloseTo(150, 1);
    expect(result.y).toBeCloseTo(26, 1);
  });

  it("tracer(150,150,124,0.25) sits at 3 o'clock, a quarter turn clockwise", () => {
    const result = tracer(150, 150, 124, 0.25);
    expect(result.x).toBeCloseTo(274, 1);
    expect(result.y).toBeCloseTo(150, 1);
  });
});

describe("ticks — evenly spaced tick marks, clockwise from 12 o'clock", () => {
  it("ticks(150,150,132,146,60) has 60 entries", () => {
    const result = ticks(150, 150, 132, 146, 60);
    expect(result).toHaveLength(60);
  });

  it("first tick is vertical, straight up from centre", () => {
    const result = ticks(150, 150, 132, 146, 60);
    expect(result[0]).toEqual({ x1: 150, y1: 18, x2: 150, y2: 4 });
  });
});
