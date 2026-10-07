/**
 * The water tile's liquid, as numbers (2026-10-03). Pure: components/today/WaterLiquid.tsx draws
 * these paths each frame. Two sine waves ride a surface that tilts with the phone and sloshes after
 * a change; the level is the day's share of the goal.
 */

/** The surface never tilts past this, however far the phone leans. */
export const TILT_LIMIT_DEG = 15;
/** An empty glass still shows a sliver of water; a met goal fills to here, not to the brim. */
export const LEVEL_EMPTY = 0.07;
export const LEVEL_FULL = 0.84;

export type Wave = {
  /** Crest height in px. */
  amplitude: number;
  /** Crest to crest in px. */
  wavelength: number;
  /** Phase in radians; the caller advances it with time. */
  phase: number;
};

/** The day's share of the goal as a fill height, 0..1 of the tile. Past the goal it stays full. */
export function fillFraction(cups: number, goal: number): number {
  const share = goal > 0 && Number.isFinite(cups) ? Math.min(1, Math.max(0, cups / goal)) : 0;
  return LEVEL_EMPTY + share * (LEVEL_FULL - LEVEL_EMPTY);
}

/** Device roll (DeviceOrientationEvent.gamma, degrees) to a surface tilt, clamped to ±15°. */
export function clampTilt(gamma: number | null | undefined): number {
  if (typeof gamma !== "number" || !Number.isFinite(gamma)) return 0;
  return Math.min(TILT_LIMIT_DEG, Math.max(-TILT_LIMIT_DEG, gamma));
}

/** Frame-rate independent easing toward a target: `rate` is the fraction closed per second. */
export function smoothToward(current: number, target: number, dtSeconds: number, rate = 6): number {
  const k = 1 - Math.exp(-rate * Math.max(0, dtSeconds));
  return current + (target - current) * k;
}

/**
 * The surface height at `x`. Positive tilt raises the right side, as water does when the phone's
 * right edge dips: the liquid runs downhill and stays level with the ground.
 */
export function surfaceY(x: number, width: number, baseY: number, tiltDeg: number, wave: Wave): number {
  const slope = Math.tan((tiltDeg * Math.PI) / 180);
  const k = (2 * Math.PI) / Math.max(1, wave.wavelength);
  return baseY - (x - width / 2) * slope + wave.amplitude * Math.sin(k * x + wave.phase);
}

/** A closed path: the wavy surface across the tile, then down and along the bottom. */
export function liquidPath(width: number, height: number, baseY: number, tiltDeg: number, wave: Wave,
  samples = 24): string {
  const step = width / samples;
  const points: string[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const x = i * step;
    const y = Math.min(height, Math.max(-height, surfaceY(x, width, baseY, tiltDeg, wave)));
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return `${points.join(" ")} L${width.toFixed(1)} ${height.toFixed(1)} L0 ${height.toFixed(1)} Z`;
}

/**
 * How much the surface is still moving `age` seconds after a change: a kick that decays, so a new
 * cup sets the water rocking and it settles back to the gentle idle swell.
 */
export function sloshEnergy(ageSeconds: number): number {
  if (!(ageSeconds >= 0)) return 0;
  return Math.exp(-ageSeconds * 1.8);
}
