import { describe, expect, it } from "vitest";
import { createSurface, heightAt, restLine, splash, stepSurface, surfaceEnergy } from "./water-surface";

const W = 350;
const run = (s: ReturnType<typeof createSurface>, seconds: number, tilt = 0) => {
  for (let t = 0; t < seconds; t += 1 / 60) stepSurface(s, 1 / 60, tilt, W);
};

describe("the basin's water surface", () => {
  it("carries a splash across the basin as a wave, then settles flat", () => {
    const s = createSurface();
    splash(s, 40, W, 200);
    run(s, 1.2);
    // The far side has moved: the disturbance travelled.
    expect(Math.abs(heightAt(s, 300, W))).toBeGreaterThan(0.01);
    run(s, 8);
    expect(surfaceEnergy(s)).toBeLessThan(0.5);
    expect(Math.abs(heightAt(s, 175, W))).toBeLessThan(0.5);
  });

  it("leans with the phone and settles on the tilted line, the middle unmoved", () => {
    const s = createSurface();
    run(s, 10, 12);
    const n = s.heights.length;
    expect(s.heights[0]).toBeCloseTo(restLine(0, n, W, 12), 0);
    expect(s.heights[n - 1]).toBeCloseTo(restLine(n - 1, n, W, 12), 0);
    // Screen y: a positive tilt raises the right side (smaller y), as the tile's water does.
    expect(s.heights[n - 1]).toBeLessThan(0);
    expect(s.heights[0]).toBeGreaterThan(0);
    expect(Math.abs(heightAt(s, W / 2, W))).toBeLessThan(1);
  });

  it("leans the other way for the other tilt", () => {
    const s = createSurface();
    run(s, 10, -12);
    expect(s.heights[s.heights.length - 1]).toBeGreaterThan(0);
    expect(s.heights[0]).toBeLessThan(0);
  });

  it("stays stable at a slow, uneven frame rate", () => {
    const s = createSurface();
    splash(s, 175, W, 400);
    for (let i = 0; i < 300; i += 1) stepSurface(s, i % 3 === 0 ? 0.05 : 0.008, 0, W);
    for (const h of s.heights) expect(Number.isFinite(h) && Math.abs(h) < 60).toBe(true);
  });
});
