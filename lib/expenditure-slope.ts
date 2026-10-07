/**
 * Robust weight slope for the expenditure engine (TDEE step E5,
 * docs/specs/phase-16-adaptive-handoff.md). Pure: no I/O, no clock.
 *
 * Theil–Sen: the slope is the median of every pairwise slope, so a single water spike or a
 * mistyped weigh-in moves it far less than it moves an endpoint delta. The line passes through
 * the median of `y − slope·x`, which keeps the same robustness for the level.
 */

export type DayWeight = { day: number; kg: number };
export type RobustLine = { slopeKgPerDay: number; interceptKg: number; points: number;
  spanDays: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * `null` when there are fewer than two distinct days. Callers enforce their own minimum point
 * count and span; this function only refuses what has no slope at all.
 */
export function theilSen(points: readonly DayWeight[]): RobustLine | null {
  const byDay = new Map<number, number>();
  for (const point of points) {
    if (Number.isFinite(point.day) && Number.isFinite(point.kg)) byDay.set(point.day, point.kg);
  }
  const rows = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  if (rows.length < 2) return null;
  const slopes: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      slopes.push((rows[j][1] - rows[i][1]) / (rows[j][0] - rows[i][0]));
    }
  }
  const slopeKgPerDay = median(slopes);
  const interceptKg = median(rows.map(([day, kg]) => kg - slopeKgPerDay * day));
  return { slopeKgPerDay, interceptKg, points: rows.length,
    spanDays: rows[rows.length - 1][0] - rows[0][0] };
}

/** The fitted weight on `day`. */
export function lineAt(line: RobustLine, day: number): number {
  return line.interceptKg + line.slopeKgPerDay * day;
}
