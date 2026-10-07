/**
 * The outbox's retry delay: exponential from one second, capped at a minute, with equal jitter
 * (lib/jitter.ts) so phones recovering from the same outage do not retry in lockstep. The cap
 * holds after the jitter too: the drawn delay is never above MAX_RETRY_MS.
 */
import { equalJitter, type RandomSource } from "@/lib/jitter";

const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 60_000;

/** The planned delay before the jitter: 1 s, 2 s, 4 s … 60 s. */
export function plannedBackoffMs(attempts: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

export function backoffMs(attempts: number, random: RandomSource = Math.random): number {
  return equalJitter(plannedBackoffMs(attempts), random);
}
