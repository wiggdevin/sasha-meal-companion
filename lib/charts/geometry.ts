/**
 * Chart geometry for the hand-drawn SVG trends (UI makeover §4.1). Pure numbers in, numbers out:
 * no DOM, no colour. A missing value (`null`) draws nothing and is never read as 0.
 */

export type Box = { width: number; height: number; top: number; bottom: number; left: number; right: number };

/** The plotting area inside a chart of `width` × `height` with the given padding. */
export function plotBox(width: number, height: number,
  pad: { top?: number; bottom?: number; left?: number; right?: number } = {}): Box {
  const top = pad.top ?? 0;
  const bottom = height - (pad.bottom ?? 0);
  const left = pad.left ?? 0;
  const right = width - (pad.right ?? 0);
  return { width, height, top, bottom, left, right };
}

/** A round upper bound at or above every value (1, 2, 2.5 or 5 × a power of ten), or null with none. */
export function niceCeil(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  const max = Math.max(...finite);
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= max) return step * magnitude;
  }
  return 10 * magnitude;
}

/** A value's y in the box for a linear scale from `min` (bottom) to `max` (top). */
export function yOf(value: number, min: number, max: number, box: Box): number {
  const span = max - min || 1;
  const t = (value - min) / span;
  return box.bottom - Math.max(0, Math.min(1, t)) * (box.bottom - box.top);
}

/** `n` equal columns across the box: each one's left edge, width and centre. */
export function columns(n: number, box: Box): { x: number; width: number; cx: number }[] {
  const width = n > 0 ? (box.right - box.left) / n : 0;
  return Array.from({ length: n }, (_, i) => {
    const x = box.left + i * width;
    return { x, width, cx: x + width / 2 };
  });
}

export type Bar = { index: number; x: number; y: number; width: number; height: number };

/**
 * One bar per non-null value, anchored to the baseline, `fill` of its column wide (centred). A value
 * of exactly 0 is a real zero and gets no height, but still a bar record; null gets no record.
 */
export function bars(values: readonly (number | null)[], box: Box, max: number,
  opts: { fill?: number; maxWidth?: number } = {}): Bar[] {
  const cols = columns(values.length, box);
  const fill = opts.fill ?? 0.6;
  const out: Bar[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) return;
    const col = cols[index];
    const width = Math.min(col.width * fill, opts.maxWidth ?? Infinity);
    const y = yOf(Math.max(0, value), 0, max, box);
    out.push({ index, x: col.cx - width / 2, y, width, height: box.bottom - y });
  });
  return out;
}

/**
 * Runs of present values a line may join: a new run starts after more than `maxGap` missing
 * values in a row, so a long gap is never bridged. Each run is a list of [index, value].
 */
export function runs(values: readonly (number | null)[], maxGap: number): [number, number][][] {
  const out: [number, number][][] = [];
  let current: [number, number][] = [];
  let last = -Infinity;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) return;
    if (index - last - 1 > maxGap && current.length) { out.push(current); current = []; }
    current.push([index, value]);
    last = index;
  });
  if (current.length) out.push(current);
  return out;
}

/** An SVG path per run, through each column's centre. A run of one point has no path. */
export function linePaths(values: readonly (number | null)[], box: Box, min: number, max: number,
  maxGap: number): string[] {
  const cols = columns(values.length, box);
  return runs(values, maxGap).filter((run) => run.length > 1).map((run) => run
    .map(([index, value], i) => `${i === 0 ? "M" : "L"}${round(cols[index].cx)} ${round(yOf(value, min, max, box))}`)
    .join(" "));
}

/** A [min, max] range around the values with a little room either side (weight, where 0 is not near). */
export function paddedRange(values: readonly (number | null)[], pad = 0.15): [number, number] | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const room = Math.max((hi - lo) * pad, 1);
  return [Math.floor(lo - room), Math.ceil(hi + room)];
}

/**
 * A bar as a path with its top corners rounded (`r`, at most half its width or its height) and a
 * square foot on the baseline. A zero-height bar is an empty path.
 */
export function barPath(bar: Bar, r = 4): string {
  if (bar.height <= 0 || bar.width <= 0) return "";
  const rr = Math.min(r, bar.width / 2, bar.height);
  const { x, y, width: w, height: h } = bar;
  return [`M${round(x)} ${round(y + h)}`, `V${round(y + rr)}`, `Q${round(x)} ${round(y)} ${round(x + rr)} ${round(y)}`,
    `H${round(x + w - rr)}`, `Q${round(x + w)} ${round(y)} ${round(x + w)} ${round(y + rr)}`, `V${round(y + h)}`, "Z"].join(" ");
}

export function round(n: number): number {
  return Math.round(n * 10) / 10;
}
