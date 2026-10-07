import { describe, expect, it } from "vitest";
import { lensOffset, LENS_DEFAULTS } from "./liquid-lens";

/** Every offset must fit the 8-bit channel around 0.5 once divided by the box size. */
function encodable(w: number, h: number): boolean {
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const { dx, dy } = lensOffset(x + 0.5, y + 0.5, w, h);
      if (Math.abs((dx / w) * 255) > 127.5 || Math.abs((dy / h) * 255) > 127.5) return false;
    }
  }
  return true;
}

describe("the dock's glass lens", () => {
  const w = 269;
  const h = 64;

  it("leaves the exact centre unshifted", () => {
    const { dx, dy } = lensOffset(w / 2, h / 2, w, h);
    expect(Math.abs(dx)).toBeLessThan(1e-9);
    expect(Math.abs(dy)).toBeLessThan(1e-9);
  });

  it("magnifies: a point off-centre samples from nearer the middle", () => {
    const left = lensOffset(w / 2 - 60, h / 2, w, h);
    const right = lensOffset(w / 2 + 60, h / 2, w, h);
    expect(left.dx).toBeGreaterThan(0);
    expect(right.dx).toBeLessThan(0);
    const above = lensOffset(w / 2, h / 2 - 12, w, h);
    expect(above.dy).toBeGreaterThan(0);
  });

  it("bends hardest at the rim and not at all outside the glass", () => {
    const rim = lensOffset(w / 2, 1, w, h);
    const inner = lensOffset(w / 2, h / 2 - 4, w, h);
    expect(rim.dy).toBeGreaterThan(inner.dy);
    expect(rim.dy).toBeLessThanOrEqual(LENS_DEFAULTS.rim + (h / 2) * LENS_DEFAULTS.magY);
    expect(lensOffset(1, 1, w, h)).toEqual({ dx: 0, dy: 0 });
  });

  it("keeps every offset inside the map's encodable range", () => {
    expect(encodable(w, h)).toBe(true);
    expect(encodable(h, h)).toBe(true);
  });
});
