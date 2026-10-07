/**
 * Equal jitter for a client retry delay (scale S1).
 *
 * Every phone that failed in the same outage computes the same exponential delay, so without
 * jitter they all come back in the same second and hit the recovering server together. Equal
 * jitter keeps half of the planned delay and draws the other half at random: no phone retries
 * sooner than half the plan or later than the plan, and the herd spreads over the second half of
 * the window. The random source is a parameter so a test can pin it.
 */

/** A source of numbers in [0, 1], like `Math.random`. */
export type RandomSource = () => number;

export function equalJitter(delayMs: number, random: RandomSource = Math.random): number {
  if (!(delayMs > 0)) return 0;
  const drawn = random();
  // A broken source (NaN, out of range) falls back to the plan itself, never to zero.
  const share = Number.isFinite(drawn) ? Math.min(1, Math.max(0, drawn)) : 1;
  const half = delayMs / 2;
  return Math.round(half + half * share);
}
