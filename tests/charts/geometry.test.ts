import { describe, expect, it } from "vitest";
import { barPath, bars, columns, linePaths, niceCeil, paddedRange, plotBox, runs, yOf } from "@/lib/charts/geometry";

const box = plotBox(320, 160, { top: 8, bottom: 28 });

describe("chart geometry", () => {
  it("rounds the scale up to a nice number, and has none with no values", () => {
    expect(niceCeil([1840, 2000])).toBe(2000);
    expect(niceCeil([2100, null])).toBe(2500);
    expect(niceCeil([null, undefined])).toBeNull();
  });

  it("splits the box into equal columns", () => {
    const cols = columns(7, box);
    expect(cols).toHaveLength(7);
    expect(cols[0].x).toBe(0);
    expect(cols[6].x + cols[6].width).toBeCloseTo(320);
  });

  it("draws a bar for a real 0 but none for a missing value", () => {
    const drawn = bars([1000, null, 0, 2000], box, 2000);
    expect(drawn.map((b) => b.index)).toEqual([0, 2, 3]);
    expect(drawn.find((b) => b.index === 2)?.height).toBe(0);
    expect(drawn.find((b) => b.index === 3)?.y).toBe(box.top);
    expect(barPath(drawn.find((b) => b.index === 2)!)).toBe("");
    expect(barPath(drawn[0])).toMatch(/^M.* Z$/);
  });

  it("keeps values inside the box", () => {
    expect(yOf(5000, 0, 2000, box)).toBe(box.top);
    expect(yOf(-10, 0, 2000, box)).toBe(box.bottom);
  });

  it("never bridges a gap longer than the limit", () => {
    expect(runs([1, null, null, 2, null, null, null, null, 3], 3)).toEqual([[[0, 1], [3, 2]], [[8, 3]]]);
    expect(linePaths([70, null, 71, null, null, null, null, 72], box, 60, 80, 3)).toHaveLength(1);
  });

  it("pads a range that does not start at 0", () => {
    expect(paddedRange([70, 72])).toEqual([69, 73]);
    expect(paddedRange([null])).toBeNull();
  });
});
