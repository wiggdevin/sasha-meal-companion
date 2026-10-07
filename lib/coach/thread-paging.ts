/**
 * `coach_messages.seq` is int4. The paging cursor has to stay inside it: a sentinel of
 * Number.MAX_SAFE_INTEGER reached Postgres as an out-of-range comparison and answered 500 for the
 * default, cursor-less load the client makes on every thread open (Loop 010, 2026-09-14).
 *
 * Anything that is not a usable cursor — absent, unparseable, non-finite, or not positive — means
 * "start from the newest message", which is the ceiling, never 0 (that would hide every message).
 */
export const SEQ_MAX = 2_147_483_647;

export function seqCeiling(raw: string | null): number {
  const parsed = Number(raw);
  if (raw === null || raw === "" || !Number.isFinite(parsed) || parsed <= 0) return SEQ_MAX;
  return Math.min(Math.floor(parsed), SEQ_MAX);
}

