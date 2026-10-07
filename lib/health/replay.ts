/**
 * Shortcuts cannot sign a request (architecture §5), so a payload proves freshness with its own
 * timestamp inside a ten-minute window either side of server time. Clock skew on the phone is the
 * reason the window is symmetric.
 */
export const REPLAY_WINDOW_MS = 600_000;

export function withinReplayWindow(sentAt: string, now: Date, windowMs = REPLAY_WINDOW_MS): boolean {
  const t = Date.parse(sentAt);
  if (Number.isNaN(t)) return false;
  return Math.abs(now.getTime() - t) <= windowMs;
}
