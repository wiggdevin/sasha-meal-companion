/**
 * A scanner that trusts one frame reads the wrong digit off a curved pouch. This is the whole
 * defence: the same text has to come back at least `quorum` times inside 1500 ms, and any
 * different text in between starts the run over (spec "Engines and logic").
 *
 * Pure: the caller owns the history array, so the sheet can keep it in a ref and this file
 * stays unit-testable with no timers.
 */
export type Reading = { text: string; format: string; at: number };

export const QUORUM_WINDOW_MS = 1500;
export const DEFAULT_QUORUM = 2;

/**
 * The text when the trailing run of identical readings (including `next`) reaches the quorum
 * inside the window, otherwise null. The walk stops at the first reading that disagrees, which
 * is what "a different text resets" means.
 */
export function acceptReading(
  history: Reading[],
  next: Reading,
  quorum: number = DEFAULT_QUORUM
): string | null {
  let count = 1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const prior = history[i];
    if (prior.text !== next.text) break;
    if (next.at - prior.at > QUORUM_WINDOW_MS) break;
    count += 1;
    if (count >= quorum) return next.text;
  }
  return count >= quorum ? next.text : null;
}

/** Keep the history bounded: inside the window, and at most `keep` entries. */
export function pruneHistory(history: Reading[], now: number, keep = 10): Reading[] {
  const fresh = history.filter((r) => now - r.at <= QUORUM_WINDOW_MS);
  return fresh.length > keep ? fresh.slice(fresh.length - keep) : fresh;
}

/** A frame every 150 ms means 5 in a row is under a second — long enough to rule out one bad
 * frame, short enough that the user is not left staring at a broken scanner for a full retry cycle. */
export const SCAN_ERROR_THRESHOLD = 5;

/** True once consecutive decode errors (worker.ts ScanReply.error) show this is not "nothing in
 * frame yet" but the decoder itself failing every frame. */
export function isPersistentScanFailure(consecutiveErrors: number): boolean {
  return consecutiveErrors >= SCAN_ERROR_THRESHOLD;
}
