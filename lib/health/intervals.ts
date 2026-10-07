/**
 * Architecture §3.5: steps and active energy are the union of non-overlapping intervals, preferring
 * the Watch-tagged sample on an overlap. Preferred intervals are laid down first and claim their
 * whole span; every later interval contributes only the fraction of its span still uncovered, so a
 * phone's duplicate hour adds nothing while its extra half-hour still counts.
 */
export type Interval = { start: number; end: number; value: number; preferred: boolean };

type Range = { start: number; end: number };

/** Half-open ranges: [0,100) and [100,200) are adjacent, not overlapping. */
function coveredWithin(claimed: Range[], start: number, end: number): number {
  let sum = 0;
  for (const c of claimed) {
    const lo = Math.max(c.start, start);
    const hi = Math.min(c.end, end);
    if (hi > lo) sum += hi - lo;
  }
  return sum;
}

/** Keeps `claimed` merged and disjoint, so coveredWithin can never count the same millisecond twice. */
function claim(claimed: Range[], start: number, end: number): void {
  if (end <= start) return;
  let lo = start;
  let hi = end;
  for (let i = claimed.length - 1; i >= 0; i -= 1) {
    const c = claimed[i];
    if (c.start <= hi && lo <= c.end) {
      lo = Math.min(lo, c.start);
      hi = Math.max(hi, c.end);
      claimed.splice(i, 1);
    }
  }
  claimed.push({ start: lo, end: hi });
}

/**
 * The union's total and which inputs actually contributed, by input index. An interval fully covered
 * by one already laid down adds nothing, so it must not be named as the source behind a metric
 * (Sol audit, T11a); `contributing[i]` is true only for the inputs that added something.
 */
export function unionNonOverlappingDetail(intervals: Interval[]): { total: number;
  contributing: boolean[] } {
  const contributing = intervals.map(() => false);
  if (intervals.length === 0) return { total: 0, contributing };

  const ordered = intervals.map((interval, index) => ({ interval, index })).sort((a, b) => {
    if (a.interval.preferred !== b.interval.preferred) return a.interval.preferred ? -1 : 1;
    return Math.min(a.interval.start, a.interval.end) - Math.min(b.interval.start, b.interval.end);
  });

  const claimed: Range[] = [];
  const points = new Set<number>();
  let total = 0;

  for (const { interval, index } of ordered) {
    const start = Math.min(interval.start, interval.end);
    const end = Math.max(interval.start, interval.end);
    const span = end - start;

    if (span === 0) {
      const inside = points.has(start) || claimed.some((c) => start >= c.start && start < c.end);
      if (!inside) {
        points.add(start);
        total += interval.value;
        contributing[index] = true;
      }
      continue;
    }

    const covered = coveredWithin(claimed, start, end);
    if (span - covered > 0) contributing[index] = true;
    total += interval.value * ((span - covered) / span);
    claim(claimed, start, end);
  }

  return { total, contributing };
}

export function unionNonOverlapping(intervals: Interval[]): number {
  return unionNonOverlappingDetail(intervals).total;
}
