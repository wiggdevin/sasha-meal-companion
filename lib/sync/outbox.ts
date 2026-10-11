// lib/sync/outbox.ts
/**
 * The outbox — architecture §3.7. A local write lands first, its op queues here, and a failed push
 * retries with backoff. Nothing here talks to the network: `drainOutbox` takes the push function,
 * so the tests drive it with a fake.
 */
import {
  allOps, appendOp, appendOpWithRow, countOps, deleteOp, deleteRow, getCursor,
  putOp, setCursor, wireOp, type AccountHandle, type OutboxOp, type OwnedOp, type QueuePrecondition,
  type QueuedSyncOp,
} from "./idb";
import { drainable, handleLogEntryResult } from "./log-entry-ops";
import { applyFoodMembershipResult, type SyncResult } from "./outbox-membership";
import { encodeKey } from "./keys";
import { type Row } from "./merge";
import { serverTimestampOf, settleConflict, TARGETS_CHANGED_EVENT } from "./outbox-conflict";
import { isRoleDelta } from "./role-delta";
import { headOfLine, requeueInPlace, retryStaleRead, settleAppliedRow } from "./row-queue";
import { projectMirroredPlanDay } from "./plan-days";
import { clearPulledUserSettings, mutateSettingsRow, USER_SETTINGS_KEY, settleUserSettings, selectAndFreezeSettings } from "./settings";
import type { OpResult, OpsResponse, SyncOp } from "./types";
import { withSettingsProvenance } from "./user-settings";
import { backoffMs } from "./backoff";
import {
  backOffTransport, isBodyFault, parkOrRetry, releaseParkedOnNewBuild, retryParked,
} from "./outbox-park";

export { USER_SETTINGS_KEY };
export { backoffMs, retryParked };

export const MAX_OPS_PER_PUSH = 200;
/** The routes accept a 1 MB body; leave headroom for the JSON envelope and headers. */
export const MAX_PUSH_BYTES = 900_000;
export { serverTimestampOf, TARGETS_CHANGED_EVENT };
/**
 * Announced right after an op is queued, so a sync can be scheduled for it. Nothing here pushes —
 * this file never talks to the network — SyncBootstrap listens and runs the pass.
 *
 * Without it, a write that goes only through this outbox (water, favorites, recipes, body profile,
 * the estimator) had no post-write trigger at all: SyncBootstrap's "1.5 s after a local save" hangs
 * off lib/store.ts, which those writes never touch, so the op waited for a remount, a tab switch or
 * an `online` event. Loop 010 measured a queued cup still unsent after 8 s.
 */
export const OUTBOX_QUEUED_EVENT = "meal-companion:outbox-queued";

export type PushFn = (ops: OwnedOp[]) => Promise<OpsResponse>;

export type DrainResult = {
  pushed: number; applied: number; conflicts: number;
  dropped: number; errored: number; failed: boolean; retryAfterMs: number | null;
};

/** `entity_id` IS the `entity_key` of contracts §4. A create or update carries the key columns in
 *  its payload, so the two must agree; a delete or restore may send an empty payload. */
function assertKeyMatchesPayload(op: SyncOp): void {
  // A role delta is keyed by entity_id alone (lib/sync/role-delta.ts).
  if (op.kind === "delete" || op.kind === "restore" || isRoleDelta(op)) return;
  const fromPayload = encodeKey(op.entity, op.payload);
  if (fromPayload !== op.entity_id) {
    throw new TypeError(
      `${op.entity}: entity_id ${op.entity_id} does not match its payload key ${fromPayload}`,
    );
  }
}

/** There is something to send. Also said by the commit path, once it lets go of an entry. */
export function announceQueued(): void {
  globalThis.dispatchEvent?.(new Event(OUTBOX_QUEUED_EVENT));
}

export async function enqueue(h: AccountHandle, op: SyncOp, now: number = Date.now()): Promise<OutboxOp> {
  assertKeyMatchesPayload(op);
  const queued = await appendOp(h, op, now);
  announceQueued();
  return queued;
}

/**
 * Queue an op and commit its mirror row in the same transaction (idb.appendOpWithRow). Same key
 * check as `enqueue` — the mirror row is stale the moment the two disagree — and the entity and its
 * key come from the op, so the row cannot be filed under a key of its own choosing.
 */
export async function enqueueWithRow(
  h: AccountHandle, row: Record<string, unknown>, op: QueuedSyncOp, now: number = Date.now(),
  precondition?: QueuePrecondition,
): Promise<OutboxOp> {
  assertKeyMatchesPayload(op);
  const queued = await appendOpWithRow(h, row, op, now, precondition);
  announceQueued();
  return queued;
}

/** The one settings entity — the row lib/sync/settings.ts owns the baseline and mirror of. */
const SETTINGS = "user_settings";

/**
 * The atomic read-modify-write for `user_settings` — the ONE row that more than one writer rewrites
 * whole (the body profile's four fields, water's goal columns), and the one a pull also writes. It
 * lives in lib/sync/settings.ts, because the write is not only a merge: it has to fold this edit
 * into the single pending op the queue is allowed to hold, anchored at the known baseline rev
 * (T11b seventh-round P1), and commit the mirror, the op and the baseline together.
 *
 * `mutate` must be synchronous; see `mutateRowWithOp`.
 */
export async function mutateUserSettings<T>(
  h: AccountHandle, mutate: (current: Row) => { row: Row; op: SyncOp; result: T },
  now: number = Date.now(),
): Promise<T> {
  // Every client write to user_settings passes here, so the provenance rule has one home.
  return mutateSettingsRow(h, (current) => withSettingsProvenance(current as Row, mutate(current as Row)), now);
}

export function pendingCount(h: AccountHandle): Promise<number> {
  return countOps(h);
}

/** The routes' cap is a real HTTP body byte count, so it must be measured in UTF-8 bytes, not JS
 *  string .length (UTF-16 code units) — a note in Hiragana, Chinese or emoji is several bytes on
 *  the wire per unit of .length, and undercounting it here would push a request past the server's
 *  actual limit while this batcher still thought it had headroom. */
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** One request must stay under the routes' body cap, however big the user's notes got. Trailing ops stay
 *  queued for the next drain; at least one op always goes, or the outbox could never empty. */
function capByBytes(ops: OutboxOp[]): OutboxOp[] {
  const out: OutboxOp[] = [];
  let bytes = byteLength('{"ops":[]}');
  for (const op of ops) {
    const size = byteLength(JSON.stringify(wireOp(op))) + (out.length > 0 ? 1 : 0);
    if (out.length > 0 && bytes + size > MAX_PUSH_BYTES) break;
    bytes += size;
    out.push(op);
  }
  return out;
}

async function onConflict(
  h: AccountHandle, result: Extract<OpResult, { status: "conflict" }>, op: OutboxOp, now: () => number,
): Promise<void> {
  // An edit queued behind `op` while the rebase is worked out makes the requeue refuse, and the
  // rebase is worked out again with it (lib/sync/row-queue.ts).
  const requeued = await retryStaleRead(async () => {
    const rebase = await settleConflict(h, result, op, now);
    if (!rebase) return false;
    assertKeyMatchesPayload(rebase.op);
    await requeueInPlace(h, op, rebase.op, rebase.retire, rebase.mirror, now(), rebase.seen);
    return true;
  });
  if (!requeued) return;
  // Today reads the legacy day, so a day merged with another device's edits is shown there (A141).
  if (op.entity === "plan_days") await projectMirroredPlanDay(h, op.entity_id);
  announceQueued();
}

/** An `applied` result carries no row — what applying one means depends on `op.kind`. */
async function applyApplied(
  h: AccountHandle, result: Extract<OpResult, { status: "applied" }>, op: OutboxOp, now: () => number,
): Promise<void> {
  if (op.entity === SETTINGS && op.kind !== "delete" && op.kind !== "restore") {
    // A whole-row write the server accepted IS the new baseline; the mirror is then the baseline
    // plus whatever is still queued, so a later op's payload is never replayed twice.
    return settleUserSettings(h, op, { status: "applied", rev: result.rev }, now());
  }
  // One transaction decides and writes (lib/sync/row-queue.ts): a newer op for this row queued
  // before the write keeps the mirror, which already holds its state (audit 2026-10-10 A138).
  const at = new Date(now()).toISOString();
  const outcome = await settleAppliedRow(h, op, (local) => {
    // Tombstone, don't merge: the server accepted an empty-payload delete, and merging {}
    // would leave the row looking untouched except for its rev.
    if (op.kind === "delete") return { ...(local ?? op.payload), deleted_at: at, rev: result.rev };
    if (op.kind === "restore") return local ? { ...local, deleted_at: null, rev: result.rev } : null;
    return { ...(local ?? {}), ...op.payload, rev: result.rev };
  });
  if (outcome !== "missing") return;
  // A restore with nothing here to un-tombstone (this device may have GC'd it already), and
  // 'applied' carries no row — only rev/seq. Roll the cursor back to just before this change so
  // the next pullChanges() re-fetches its full `current` snapshot from sync_changes. A row the feed
  // never logged answers seq 0: there is nothing to re-fetch, and a cursor of -1 is one the feed
  // refuses, which would stop every later pull (audit 2026-10-10 P09).
  const cursor = await getCursor(h);
  if (result.seq > 0 && result.seq - 1 < cursor) await setCursor(h, result.seq - 1);
  await deleteOp(h, op.op_id);
}

export async function applyResult(
  h: AccountHandle, result: SyncResult, op: OutboxOp, now: () => number = Date.now,
): Promise<void> {
  // A log entry's answers are its own: lib/sync/log-entry-ops.ts.
  if (await applyFoodMembershipResult(h, result, op,
    () => parkOrRetry(h, op, "unexpected rejected result", now))) return;
  if (op.entity === "log_entries" && await handleLogEntryResult(h, result as OpResult, op)) return;
  if (result.status === "applied") return applyApplied(h, result, op, now);
  if (result.status === "conflict") return onConflict(h, result, op, now);
  if (result.status === "deleted") {
    // A tombstoned settings row must take its baseline with it, or the next settlement would
    // rebuild the mirror from a row the server no longer has. (The server never tombstones it —
    // delete and restore answer 'unsupported' — so this is a guard, not a path.)
    if (op.entity === SETTINGS) {
      await clearPulledUserSettings(h);
      await deleteOp(h, op.op_id);
      return;
    }
    await deleteRow(h, op.entity, op.entity_id);
    await deleteOp(h, op.op_id);
    return;
  }
  if (result.status === "unsupported") {
    console.warn(`sync: op ${op.op_id} (${op.entity} ${op.kind}) is unsupported by the server; dropping`);
    return dropOp(h, op);
  }
  if (result.status === "error") {
    // A database hiccup is not the op's fault: it waits like a transport failure and keeps its
    // error budget (audit 2026-10-10 A137).
    if (result.retryable === true) {
      await backOffTransport(h, [op], now());
      return;
    }
    await parkOrRetry(h, op, result.message, now);
    return;
  }
  if (result.status === "duplicate" && op.entity === SETTINGS) {
    // `duplicate` means the SERVER already holds this generation's payload; it says nothing about the
    // rev it landed on or about the generation recorded since, so it settles its own generation and
    // no more (lib/sync/settings.ts).
    return settleUserSettings(h, op, { status: "duplicate" }, now());
  }
  if (result.status === "gone") return onGone(h, op, now);
  return dropOp(h, op); // 'duplicate': the op has nothing left to do
}

/**
 * `gone` means the server never had (and does not have) a row for this entity_id — unlike
 * `deleted`, there is nothing to tombstone. A delete/restore already agrees with that "nothing
 * here", so bring the mirror in line and drop the op. For a create/update, the user's edit is
 * still real and unsent: `dropOp` would silently discard it AND empty the outbox, so SyncStatus
 * would report "everything is sent" for a change that never reached the server (audit finding 35).
 * Re-queue it as the create it always should have been instead — same op_id, so it stays counted as
 * pending until it actually lands.
 */
async function onGone(h: AccountHandle, op: OutboxOp, now: () => number): Promise<void> {
  // A role delta on a pref another device removed: recreating it would bring the food back (P15).
  if (op.kind === "delete" || op.kind === "restore" || isRoleDelta(op)) {
    await deleteRow(h, op.entity, op.entity_id);
    await deleteOp(h, op.op_id);
    return;
  }
  await putOp(h, { ...op, kind: "create", base_rev: null, next_attempt_at: now() });
}

/**
 * The op leaves the queue without the server having applied it just now. For `user_settings` the
 * mirror is rebuilt from the baseline, because that is the only record of the server's row: a
 * `duplicate` means the op was applied EARLIER (its effect is already in a pulled baseline), so
 * re-adding its payload afterwards would strand a value the server has since moved past (T11b
 * audit finding 2).
 */
async function dropOp(h: AccountHandle, op: OutboxOp): Promise<void> {
  if (op.entity === SETTINGS) return settleUserSettings(h, op, { status: "drop" });
  await deleteOp(h, op.op_id);
}

export async function drainOutbox(h: AccountHandle, push: PushFn, now: () => number = Date.now): Promise<DrainResult> {
  const all = await allOps(h);
  // Sample the due-time after the snapshot. A settings edit may land in the intentional seam
  // between this read and selectAndFreezeSettings; using the earlier timestamp can make that fresh
  // generation look future-dated and skip the very op the atomic selection just froze.
  const at = now();
  // Every other entity's due ops come from this snapshot. The `user_settings` half does NOT: the
  // generation it puts on the wire is selected and frozen by ONE transaction inside
  // `selectAndFreezeSettings`, because an edit landing between a snapshot and a freeze would replace
  // the op the snapshot named (T11b ninth-round P1).
  // One op per row per push, the row's oldest (lib/sync/row-queue.ts, audit 2026-10-10 A165).
  const ready = await drainable(headOfLine(all,
    all.filter((o) => o.next_attempt_at <= at && o.entity !== SETTINGS)));
  const { op: settingsOp, parked } = await selectAndFreezeSettings(h, at);
  const send = [...ready, ...(settingsOp === null ? [] : [settingsOp])]
    .sort((a, b) => a.seq - b.seq);
  const due = capByBytes(send.slice(0, MAX_OPS_PER_PUSH));
  const empty: DrainResult = {
    pushed: 0, applied: 0, conflicts: 0, dropped: 0, errored: 0, failed: false, retryAfterMs: null,
  };
  if (due.length === 0) return { ...empty, failed: parked > 0 };

  const out: DrainResult = { ...empty };
  await sendInParts(h, push, due, out, at, now);
  return out;
}

/**
 * Send `due`, and when the route refuses a request for what it carries (`isBodyFault`), split it
 * and send each half, down to the one op the refusal belongs to: only that op is charged (audit
 * 2026-10-10 A076). One bad op among 200 costs about 2·log2(200) requests, once. Any other failure
 * — offline, a 5xx, a lapsed session — backs off this part and every part still waiting, and charges
 * none of them.
 */
async function sendInParts(
  h: AccountHandle, push: PushFn, due: OutboxOp[], out: DrainResult, at: number, now: () => number,
): Promise<void> {
  const parts: OutboxOp[][] = [due];
  while (parts.length > 0) {
    const part = parts.shift()!;
    let response: OpsResponse;
    try {
      response = await push(part.map(wireOp));
    } catch (e) {
      if (isBodyFault(e) && part.length > 1) {
        const half = Math.ceil(part.length / 2);
        parts.unshift(part.slice(0, half), part.slice(half));
        continue;
      }
      out.failed = true;
      if (isBodyFault(e)) {
        await parkOrRetry(h, part[0], `push rejected with ${e.status}`, now);
        out.errored += 1;
        continue;
      }
      const wait = await backOffTransport(h, [...part, ...parts.flat()], at);
      out.retryAfterMs = Math.min(out.retryAfterMs ?? wait, wait);
      return;
    }
    await applyResponse(h, part, response, out, at, now);
  }
}

async function applyResponse(
  h: AccountHandle, due: OutboxOp[], response: OpsResponse, out: DrainResult, at: number,
  now: () => number,
): Promise<void> {
  const byId = new Map(due.map((o) => [o.op_id, o]));
  const answered = new Set<string>();
  out.pushed += due.length;
  for (const result of response.results as SyncResult[]) {
    if (!result || typeof result !== "object") continue; // a malformed row must not crash the drain
    const op = byId.get(result.op_id);
    if (!op) continue;
    answered.add(op.op_id);
    await applyResult(h, result, op, now);
    if (result.status === "applied") out.applied += 1;
    else if (result.status === "conflict" || result.status === "rejected") out.conflicts += 1;
    // A 'gone' create/update is re-queued by onGone, not dropped — it still needs another attempt,
    // same as 'error'.
    else if (result.status === "error"
      || (result.status === "gone" && op.kind !== "delete" && op.kind !== "restore")) {
      out.errored += 1;
    } else out.dropped += 1; // 'deleted', 'gone' (delete/restore), 'duplicate', 'unsupported'
  }

  const unanswered = due.filter((o) => !answered.has(o.op_id));
  if (unanswered.length > 0) {
    out.failed = true;
    const wait = await backOffTransport(h, unanswered, at);
    out.retryAfterMs = Math.min(out.retryAfterMs ?? wait, wait);
  }
  // A new deploy answered: an op it may have fixed is due again (lib/sync/outbox-park.ts).
  if (await releaseParkedOnNewBuild(h, response.server_build, now()) > 0) announceQueued();
}
