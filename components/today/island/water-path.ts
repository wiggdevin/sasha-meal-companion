/** The basin's SVG water (the stand-in where WebGL is missing, and its still frame). */

/** A smooth curve through the samples (midpoint quadratics), so the surface never shows a corner. */
export function surfacePath(w: number, h: number, ys: number[]): { body: string; line: string } {
  const step = w / (ys.length - 1);
  const parts = [`M0 ${ys[0].toFixed(1)}`];
  for (let i = 1; i < ys.length - 1; i += 1) {
    const mx = (i + 0.5) * step;
    const my = (ys[i] + ys[i + 1]) / 2;
    parts.push(`Q${(i * step).toFixed(1)} ${ys[i].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`);
  }
  parts.push(`L${w.toFixed(1)} ${ys[ys.length - 1].toFixed(1)}`);
  const line = parts.join(" ");
  return { line, body: `${line} L${w.toFixed(1)} ${h.toFixed(1)} L0 ${h.toFixed(1)} Z` };
}
