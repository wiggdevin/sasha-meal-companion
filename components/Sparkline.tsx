/**
 * Seven-day sparkline, hand-written SVG, no dependency (contracts §1). A null point is a GAP: the
 * path breaks rather than dipping to zero, because a missing observation is not a zero (§9).
 * Stroke widths and the muted colour come from DESIGN.md; the default stroke is the olive accent.
 *
 * A contiguous run of two or more observations draws a line. A lone observation draws a dot — as a
 * zero-length subpath, which a round line cap renders as a circle — so a real reading between two
 * gaps is never dropped. Only a series with fewer than two observations overall (a single reading or
 * all gaps) has nothing to plot and returns no segments.
 */
export function sparklineSegments(points: (number | null)[], width: number, height: number): string[] {
  const values = points.filter((p): p is number => p !== null);
  if (values.length < 2) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = points.length > 1 ? width / (points.length - 1) : 0;

  const coords = points.map((point, index) => point === null ? null
    : { x: Math.round(index * step * 100) / 100,
        y: span === 0 ? height / 2
          : Math.round((height - ((point - min) / span) * height) * 100) / 100 });

  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  for (const coord of coords) {
    if (coord === null) flush(); else run.push(coord);
  }
  flush();
  return runs.map((points) => points.length === 1
    ? `M${points[0].x},${points[0].y} L${points[0].x},${points[0].y}`
    : points.map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`).join(" "));
}

export default function Sparkline({ points, width = 120, height = 28, stroke = "var(--color-primary)", label }: {
  points: (number | null)[]; width?: number; height?: number; stroke?: string; label: string;
}) {
  const segments = sparklineSegments(points, width, height);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={label} style={{ overflow: "visible" }}>
      {segments.map((d) => (
        <path key={d} d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round"
          strokeLinejoin="round" />
      ))}
    </svg>
  );
}
