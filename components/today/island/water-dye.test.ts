import { describe, expect, it } from "vitest";
import { createDye, dyeAmount, dyeBusy, pack, squirt, stepDye, type Dye } from "./water-dye";

const centre = (d: Dye, field: Float32Array) => {
  let sx = 0; let sy = 0; let m = 0;
  for (let j = 1; j <= d.ny; j += 1) {
    for (let i = 1; i <= d.nx; i += 1) {
      const v = field[i + (d.nx + 2) * j];
      sx += v * i; sy += v * j; m += v;
    }
  }
  return { x: sx / m, y: sy / m, m };
};
const run = (d: Dye, seconds: number, fps = 60) => { for (let t = 0; t < seconds; t += 1 / fps) stepDye(d, 1 / fps); };
const LEFT = { x: 0.02, y: 0.1, dx: 0.86, dy: 0.5, speed: 120, ink: 6, channel: "a" as const };
const RIGHT = { x: 0.98, y: 0.22, dx: -0.9, dy: 0.42, speed: 120, ink: 6, channel: "b" as const };

describe("two inks in clear water", () => {
  it("squirts an ink in from its wall, carries it toward the middle, and lets it sink", () => {
    const d = createDye();
    squirt(d, LEFT, 1.2);
    run(d, 0.3);
    const early = centre(d, d.a);
    run(d, 2);
    const late = centre(d, d.a);
    expect(late.x).toBeGreaterThan(early.x + 4);
    expect(late.y).toBeGreaterThan(early.y + 2);
    expect(dyeBusy(d)).toBe(true);
  });

  it("brings the two jets together in the middle, where they mix", () => {
    const d = createDye();
    squirt(d, LEFT, 1.2);
    squirt(d, { ...RIGHT, wait: 0.35 }, 1.2);
    run(d, 3);
    const a = centre(d, d.a);
    const b = centre(d, d.b);
    expect(a.x).toBeLessThan(b.x);
    expect(b.x - a.x).toBeLessThan(d.nx * 0.6);
    // Somewhere both inks share a cell: they have met.
    let shared = 0;
    for (let k = 0; k < d.a.length; k += 1) if (d.a[k] > 0.05 && d.b[k] > 0.05) shared += 1;
    expect(shared).toBeGreaterThan(5);
  });

  it("is the same physics at 60 and 120 frames a second (fixed steps)", () => {
    const at60 = createDye(); squirt(at60, LEFT, 1); run(at60, 1.5, 60);
    const at120 = createDye(); squirt(at120, LEFT, 1); run(at120, 1.5, 120);
    expect(Math.abs(dyeAmount(at60) - dyeAmount(at120))).toBeLessThan(dyeAmount(at60) * 0.05);
  });

  it("settles after the show: the flow comes to rest and the inks clear within about 20 s", () => {
    // A quarter-size grid: the settling runs on time, not on the grid, and it keeps the test quick.
    const d = createDye(48, 24);
    squirt(d, LEFT, 1.3);
    squirt(d, { ...RIGHT, wait: 0.35 }, 1.3);
    run(d, 14);
    expect(dyeBusy(d)).toBe(true);
    expect(Math.max(...d.u.map(Math.abs), ...d.v.map(Math.abs))).toBe(0);
    run(d, 10);
    expect(dyeBusy(d)).toBe(false);
  });

  it("stays finite and bounded however long it runs, and packs into a texture", () => {
    const d = createDye();
    for (let k = 0; k < 6; k += 1) { squirt(d, LEFT, 1); squirt(d, RIGHT, 1); run(d, 1, 30); }
    for (const v of d.u) expect(Number.isFinite(v) && Math.abs(v) <= 140).toBe(true);
    const rgba = pack(d);
    expect(rgba.length).toBe(d.nx * d.ny * 4);
    expect(Math.max(...rgba)).toBeLessThanOrEqual(255);
  });
});
