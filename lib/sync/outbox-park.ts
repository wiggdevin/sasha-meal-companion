/**
 * How the drain waits: a transport failure backs off, an op's own server error spends its error
 * budget and then parks, and a park is released when a fix can have reached it (W026, audit
 * 2026-10-10 A076, A137). Split out of lib/sync/outbox.ts, which the 400-line module rule holds.
 *
 * - `attempts` counts failures that are not the op's fault (offline, a 5xx, a lapsed session, a
 *   database hiccup); they only lengthen the wait, never park.
 * - `error_attempts` counts the server refusing this op specifically; at MAX_ERROR_ATTEMPTS the op
 *   is parked: left in the outbox (pendingCount and SyncStatus still count it) with its next
 *   attempt pushed out of reach.
 * - A parked op is released by "Sync now" (`retryParked`), and on its own when a different server
 *   build answers (`releaseParkedOnNewBuild`): a deploy is how a fix reaches the op it refused.
 */
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import { getMeta, META_STORE, OUTBOX_STORE, openAccountDb, putOp, type OutboxOp } from "./idb";
import { SyncHttpError } from "./client";
import { backoffMs, MAX_RETRY_MS } from "./backoff";
import { PARK_MS } from "./settings";

export const MAX_ERROR_ATTEMPTS = 3;
/** Anything further out than this is parked, not merely backing off. */
export const PARKED_FROM_MS = 24 * 60 * 60 * 1000;
/** The last server build an ops response named (META). */
export const SERVER_BUILD_KEY = "server_build";

/**
 * Statuses a request is refused with for what its BODY carries: a shape the route will not parse
 * (400), a body over its cap (413), content it cannot process (422). Only these can be one op's
 * fault. Every other 4xx — a lapsed session (401), a refusal (403), a route that is not there
 * (404, 405) — fails the same way whatever the batch holds, so it charges no op (A076).
 */
const BODY_FAULTS: ReadonlySet<number> = new Set([400, 413, 422]);

/** The request was refused for what it carried; a smaller batch may go through. */
export function isBodyFault(e: unknown): e is SyncHttpError {
  return e instanceof SyncHttpError && BODY_FAULTS.has(e.status);
}

/** Server errored on this op specifically: retried with backoff, then parked. */
export async function parkOrRetry(
  h: AccountHandle, op: OutboxOp, message: string, now: () => number,
): Promise<void> {
  const errorAttempts = (op.error_attempts ?? 0) + 1;
  if (errorAttempts >= MAX_ERROR_ATTEMPTS) {
    const build = (await getMeta<string>(h, SERVER_BUILD_KEY)) ?? null;
    await putOp(h, { ...op, error_attempts: errorAttempts, next_attempt_at: now() + PARK_MS,
      parked_build: build });
    console.warn(`sync: op ${op.op_id} parked after ${errorAttempts} server errors: ${message}`);
    return;
  }
  await putOp(h, {
    ...op, error_attempts: errorAttempts, next_attempt_at: now() + backoffMs(errorAttempts),
  });
}

/** Nothing is wrong with these ops, so they keep their error budget and only wait longer.
 *  Returns the soonest retry. */
export async function backOffTransport(h: AccountHandle, ops: OutboxOp[], at: number): Promise<number> {
  let retryAfterMs = MAX_RETRY_MS;
  for (const op of ops) {
    const attempts = op.attempts + 1;
    const wait = backoffMs(attempts);
    retryAfterMs = Math.min(retryAfterMs, wait);
    await putOp(h, { ...op, attempts, next_attempt_at: at + wait });
  }
  return retryAfterMs;
}

function isParked(op: OutboxOp, at: number): boolean {
  return op.next_attempt_at > at + PARKED_FROM_MS;
}

/** Make the picked ops due now with a fresh budget, in ONE transaction over the outbox, so an op
 *  rewritten meanwhile (a rebase, a fold) is read and released as it stands. */
async function releaseOps(
  h: AccountHandle, at: number, pick: (op: OutboxOp) => boolean, build?: string,
): Promise<number> {
  const db = await openAccountDb(h);
  const tx = db.transaction([OUTBOX_STORE, META_STORE], "readwrite");
  const outbox = tx.objectStore(OUTBOX_STORE);
  const ops = (await outbox.getAll()) as OutboxOp[];
  assertCurrent(h);
  let released = 0;
  for (const op of ops) {
    if (!pick(op)) continue;
    const { parked_build: _gone, ...rest } = op;
    void _gone;
    await outbox.put({ ...rest, attempts: 0, error_attempts: 0, next_attempt_at: at });
    released += 1;
  }
  if (build !== undefined) await tx.objectStore(META_STORE).put(build, SERVER_BUILD_KEY);
  await tx.done;
  return released;
}

/** The human action: "Sync now" calls this first, so a parked op gets one more chance without the
 *  user having to know what a parked op is. */
export async function retryParked(h: AccountHandle, now: () => number = Date.now): Promise<number> {
  const at = now();
  return releaseOps(h, at, (op) => isParked(op, at));
}

/**
 * A server build other than the last one seen answered: every op parked for its OWN errors under
 * another build (or before builds were recorded) is released, once. An op held back for another
 * reason (a settings op with no baseline: no error spent) stays where it is.
 */
export async function releaseParkedOnNewBuild(
  h: AccountHandle, build: string | undefined, at: number,
): Promise<number> {
  if (!build || (await getMeta<string>(h, SERVER_BUILD_KEY)) === build) return 0;
  return releaseOps(h, at, (op) => isParked(op, at) && (op.error_attempts ?? 0) > 0
    && op.parked_build !== build, build);
}
