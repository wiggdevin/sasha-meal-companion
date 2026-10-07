/**
 * The basin's water surface as a column height field (owner, 2026-10-06: "look a little more real
 * and react to the tilt of the phone"). Each column is a spring to its neighbours, so a disturbance
 * travels as a wave, reflects off the glass walls and fades; the whole surface chases a tilted line
 * when the phone leans, so the water sloshes and settles level with the ground. Pure numbers: the
 * component reads `heights` each frame. The idea is the classic 1D wave equation used by
 * height-field water (no code is taken from any outside project).
 */

export type Surface = {
  /** Displacement of each column from the rest line, px (positive is down, like screen y). */
  heights: Float32Array;
  velocities: Float32Array;
  /** The tilt the surface is chasing, degrees, smoothed. */
  lean: number;
};

/** How fast a wave crosses the basin (px/s), how hard each column pulls back, how fast motion fades. */
const WAVE_SPEED = 300;
const RESTORE = 6;
const DAMPING = 1.9;
/** Fixed sub-step: the spring chain is stable at this step whatever the frame rate. */
const STEP = 1 / 240;
/** The phone's lean is applied at a fraction, so a 15° tilt never empties one side of a small basin. */
const LEAN_SCALE = 0.55;

export function createSurface(columns = 48): Surface {
  return { heights: new Float32Array(columns), velocities: new Float32Array(columns), lean: 0 };
}

/**
 * Where the surface rests at column i under a lean, in screen y: a line through the middle. A
 * positive tilt raises the right side, as lib/today/water-liquid.ts `surfaceY` does: the liquid runs
 * downhill and stays level with the ground.
 */
export function restLine(i: number, columns: number, width: number, leanDeg: number): number {
  const x = (i / (columns - 1)) * width - width / 2;
  return -x * Math.tan((leanDeg * LEAN_SCALE * Math.PI) / 180);
}

/** Advance the surface by dt seconds toward the phone's tilt, in fixed sub-steps. */
export function stepSurface(surface: Surface, dt: number, tiltDeg: number, width: number): void {
  const { heights: h, velocities: v } = surface;
  const n = h.length;
  const dx = width / (n - 1);
  const k = (WAVE_SPEED / dx) ** 2;
  let left = Math.min(0.05, Math.max(0, dt));
  // The lean itself eases in, so a sudden turn of the phone sends one slosh rather than a jump.
  surface.lean += (tiltDeg - surface.lean) * (1 - Math.exp(-4 * left));
  while (left > 0) {
    const step = Math.min(STEP, left);
    left -= step;
    for (let i = 0; i < n; i += 1) {
      // Waves ride the tilted rest line, so a lean is never flattened by the walls. Reflective walls:
      // the column beyond the glass mirrors the one beside it.
      const off = (j: number) => h[j] - restLine(j, n, width, surface.lean);
      const a = off(i > 0 ? i - 1 : 1);
      const b = off(i < n - 1 ? i + 1 : n - 2);
      const here = off(i);
      v[i] += (k * (a + b - 2 * here) - RESTORE * here - DAMPING * v[i]) * step;
    }
    for (let i = 0; i < n; i += 1) h[i] += v[i] * step;
  }
}

/** A drop landing at x: the column is pushed down and its neighbours a little, so a ring sets off. */
export function splash(surface: Surface, x: number, width: number, strength: number): void {
  const n = surface.heights.length;
  const at = Math.round((Math.max(0, Math.min(width, x)) / width) * (n - 1));
  for (let d = -2; d <= 2; d += 1) {
    const i = at + d;
    if (i < 0 || i >= n) continue;
    surface.velocities[i] += strength * (d === 0 ? 1 : Math.abs(d) === 1 ? 0.55 : 0.2);
  }
}

/** The surface height at x, interpolated between columns. */
export function heightAt(surface: Surface, x: number, width: number): number {
  const n = surface.heights.length;
  const f = (Math.max(0, Math.min(width, x)) / width) * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  return surface.heights[i] * (1 - t) + surface.heights[i + 1] * t;
}

/** How much the surface is moving: drives the meniscus glint and the idle swell. */
export function surfaceEnergy(surface: Surface): number {
  let sum = 0;
  for (const value of surface.velocities) sum += value * value;
  return Math.sqrt(sum / surface.velocities.length);
}
