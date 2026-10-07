/**
 * Pure SVG geometry for the Arena gauge ring — progress-arc dasharray math,
 * the tracer dot at the arc's end, and evenly-spaced tick marks. 0% starts
 * at 12 o'clock and runs clockwise. No rendering, no rounding: callers format.
 */

function clampPct(pct: number): number {
  if (pct < 0) return 0;
  if (pct > 1) return 1;
  return pct;
}

/** Point on the circle at angle `pct` of a full turn, clockwise from 12 o'clock. */
function pointOnCircle(cx: number, cy: number, r: number, pct: number): { x: number; y: number } {
  const angle = pct * 2 * Math.PI;
  return {
    x: cx + r * Math.sin(angle),
    y: cy - r * Math.cos(angle),
  };
}

/** Dasharray/dashoffset for a progress ring of radius `r` at `pct` (clamped to [0, 1]). */
export function arc(r: number, pct: number): { circumference: number; dashoffset: number } {
  const circumference = 2 * Math.PI * r;
  const dashoffset = circumference * (1 - clampPct(pct));
  return { circumference, dashoffset };
}

/** How much of a second lap is filled after the goal, capped at one extra turn. */
export function excessProgress(consumed: number, target: number): number {
  if (target <= 0 || !Number.isFinite(consumed) || !Number.isFinite(target)) return 0;
  return clampPct(consumed / target - 1);
}

/** Position of the tracer dot at the end of the progress arc. */
export function tracer(cx: number, cy: number, r: number, pct: number): { x: number; y: number } {
  return pointOnCircle(cx, cy, r, clampPct(pct));
}

/** `n` tick marks from rIn to rOut, evenly spaced clockwise starting at 12 o'clock. */
export function ticks(
  cx: number,
  cy: number,
  rIn: number,
  rOut: number,
  n: number,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const result: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = 0; i < n; i++) {
    const pct = i / n;
    const inner = pointOnCircle(cx, cy, rIn, pct);
    const outer = pointOnCircle(cx, cy, rOut, pct);
    result.push({ x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y });
  }
  return result;
}
