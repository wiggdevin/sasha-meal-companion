import { describe, expect, it } from "vitest";
import { DEFAULT_RESIZE, targetSize } from "@/lib/media/resize";

describe("targetSize", () => {
  it("fits a landscape phone photo to the long edge", () => {
    expect(targetSize(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it("fits a portrait photo to the same long edge", () => {
    expect(targetSize(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it("never enlarges an image already inside the budget", () => {
    expect(targetSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(targetSize(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it("keeps at least one pixel on the short edge of a strip", () => {
    expect(targetSize(10000, 1, 1600)).toEqual({ width: 1600, height: 1 });
  });

  it("rounds to whole pixels", () => {
    expect(targetSize(3000, 1999, 1600)).toEqual({ width: 1600, height: 1066 });
  });

  it("answers 1 x 1 for a size it cannot read", () => {
    expect(targetSize(Number.NaN, 100, 1600)).toEqual({ width: 1, height: 1 });
  });

  it("ships the architecture 4.2 defaults", () => {
    expect(DEFAULT_RESIZE).toEqual({ longEdge: 1600, quality: 0.8 });
  });
});
