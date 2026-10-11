/**
 * One row, one line of writes (audit 2026-10-10 W011: A165, A138, A164, A168).
 *
 * A row's queued ops chain: each is aimed at the revision its predecessor will produce, and the
 * mirror holds the newest one's optimistic state. Three rules keep that chain honest:
 *
 * - The drain sends a row's OLDEST queued op and nothing behind it (`headOfLine`). A successor is
 *   only sent once its predecessor has settled, so its base is compared with the server's row after
 *   that predecessor, never against another device's revision that happens to share the number.
 * - An answer about an older op leaves the mirror alone while a newer op for the row is queued
 *   (`settleAppliedRow`, one transaction with the write): the mirror already holds the newer intent.
 * - A pulled row — a delete echo included — is held, not written, while an op for it is queued
 *   (`putPulledRow`), and the change it carried is read again once the row's queue is empty
 *   (`releasePullHolds`, which moves the stored cursor back in the same transaction), so a skip
 *   never loses another device's change when the op settles without reading the row back.
 *
 * Every mirror write here is made in a transaction of its own, so each one forgets the meal
 * snapshot through `entityWritten`, as `putRow` does for the rest of the app.
 *
 * `user_settings` and `food_membership` keep their own rules (lib/sync/settings.ts,
 * lib/sync/outbox-membership.ts) and are outside all three.
 */
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import {
  CURSOR_KEY, META_STORE, OUTBOX_STORE, entityWritten, openAccountDb, outboxRow, type OutboxOp,
  type QueuedSyncOp,
} from "./idb";
import type { ChangeRow } from "./types";

const OWN_RULES: ReadonlySet<string> = new Set(["user_settings", "food_membership"]);

/** Pulled rows skipped for a queued op, by row: the lowest change seq skipped. */
export const PULL_HOLDS_KEY = "pull_holds";
type Holds = Record<string, number>;

type RowRef = { entity: string; entity_id: string };

export function rowKey(op: RowRef): string {
  return `${op.entity}\u0000${op.entity_id}`;
}

/** The due ops this push may carry: per row, only its oldest queued op. */
export function headOfLine(all: readonly OutboxOp[], due: readonly OutboxOp[]): OutboxOp[] {
  const oldest = new Map<string, number>();
  for (const op of all) {
    if (OWN_RULES.has(op.entity)) continue;
    const key = rowKey(op);
    const seen = oldest.get(key);
    if (seen === undefined || op.seq < seen) oldest.set(key, op.seq);
  }
  return due.filter((op) => OWN_RULES.has(op.entity) || oldest.get(rowKey(op)) === op.seq);
}

/** The ops queued behind `op` for its row, oldest first. */
export function queuedAfter(all: readonly OutboxOp[], op: OutboxOp): OutboxOp[] {
  return all.filter((o) => o.entity === op.entity && o.entity_id === op.entity_id && o.seq > op.seq)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Replace a refused op with its rebase in ONE transaction: the refused op and the ops folded into
 * the rebase leave, the rebase takes the refused op's place in the queue (never the tail, where it
 * would land after the very edits it carries), and the mirror takes the merged row.
 */
export async function requeueInPlace(
  h: AccountHandle, refused: OutboxOp, next: QueuedSyncOp, retire: readonly string[],
  mirror: Record<string, unknown>, now: number,
): Promise<void> {
  await replaceQueued(h, refused, outboxRow(h, next, refused.seq, now), retire, mirror);
}

/**
 * The same, for a caller that keeps the refused op's own retry state (a re-aimed note): `row` is
 * the outbox row as stored. A null `mirror` leaves the mirror as it is.
 */
export async function replaceQueued(
  h: AccountHandle, refused: OutboxOp, row: OutboxOp, retire: readonly string[],
  mirror: Record<string, unknown> | null,
): Promise<void> {
  const db = await openAccountDb(h);
  const tx = db.transaction([refused.entity, OUTBOX_STORE], "readwrite");
  const done = tx.done;
  try {
    assertCurrent(h);
    const outbox = tx.objectStore(OUTBOX_STORE);
    for (const id of [refused.op_id, ...retire]) await outbox.delete(id);
    if (mirror) await tx.objectStore(refused.entity).put(mirror, refused.entity_id);
    await outbox.put(row);
    await done;
  } catch (error) {
    try { tx.abort(); } catch { /* already finished */ }
    await done.catch(() => undefined);
    throw error;
  }
  if (mirror) entityWritten(h, refused.entity);
}

/**
 * Settle an `applied` answer in ONE transaction over the row and the outbox (audit 2026-10-10
 * A138): a newer op for the row queued at any point before the write — during the request or
 * during this settlement — keeps the mirror, which already holds its state, and only the answered
 * op leaves. Otherwise `next` builds the mirror row from the current one and the op leaves with
 * it; a null from `next` writes nothing and leaves the op for the caller (`missing`).
 */
export async function settleAppliedRow(
  h: AccountHandle, op: OutboxOp,
  next: (local: Record<string, unknown> | undefined) => Record<string, unknown> | null,
): Promise<"settled" | "superseded" | "missing"> {
  const db = await openAccountDb(h);
  const tx = db.transaction([op.entity, OUTBOX_STORE], "readwrite");
  const done = tx.done;
  let outcome: "settled" | "superseded" | "missing";
  try {
    const outbox = tx.objectStore(OUTBOX_STORE);
    const [ops, local] = await Promise.all([
      outbox.getAll() as Promise<OutboxOp[]>,
      tx.objectStore(op.entity).get(op.entity_id) as Promise<Record<string, unknown> | undefined>,
    ]);
    assertCurrent(h);
    const row = !OWN_RULES.has(op.entity) && queuedAfter(ops, op).length > 0 ? undefined : next(local);
    if (row === undefined) {
      outcome = "superseded";
      await outbox.delete(op.op_id);
    } else if (row === null) {
      outcome = "missing";
    } else {
      outcome = "settled";
      await tx.objectStore(op.entity).put(row, op.entity_id);
      await outbox.delete(op.op_id);
    }
    await done;
  } catch (error) {
    try { tx.abort(); } catch { /* already finished */ }
    await done.catch(() => undefined);
    throw error;
  }
  if (outcome === "settled") entityWritten(h, op.entity);
  return outcome;
}

type HoldStore = { get(key: string): Promise<unknown>; put(value: unknown, key: string): Promise<unknown> };

/** Remember the lowest skipped change seq for a row; call inside the skipping transaction. */
export async function recordPullHold(meta: HoldStore, change: ChangeRow): Promise<void> {
  const holds = ((await meta.get(PULL_HOLDS_KEY)) as Holds | undefined) ?? {};
  const key = rowKey({ entity: change.entity, entity_id: change.entity_key });
  if (holds[key] !== undefined && holds[key] <= change.seq) return;
  await meta.put({ ...holds, [key]: change.seq }, PULL_HOLDS_KEY);
}

/**
 * Write a pulled row into the mirror — or, for a delete echo (`current` null), take it out —
 * unless the row is this phone's to settle: an op for it is queued (held, and remembered), or the
 * mirror already holds a later revision (stale). One transaction over the row, the outbox and the
 * meta store, so a write queued meanwhile is seen. A delete echo is held like any other change
 * (audit 2026-10-10 A164): a re-star queued after an accepted unstar keeps its row until the
 * restore settles, and the echo read again then is older than the restored row.
 */
export async function putPulledRow(
  h: AccountHandle, change: ChangeRow,
): Promise<"written" | "held" | "stale"> {
  const db = await openAccountDb(h);
  const tx = db.transaction([change.entity, OUTBOX_STORE, META_STORE], "readwrite");
  const done = tx.done;
  const [ops, mirror] = await Promise.all([
    tx.objectStore(OUTBOX_STORE).getAll() as Promise<OutboxOp[]>,
    tx.objectStore(change.entity).get(change.entity_key) as Promise<{ rev?: unknown } | undefined>,
  ]);
  assertCurrent(h);
  let outcome: "written" | "held" | "stale" = "written";
  if (ops.some((op) => op.entity === change.entity && op.entity_id === change.entity_key)) {
    outcome = "held";
    await recordPullHold(tx.objectStore(META_STORE), change);
  } else if (typeof mirror?.rev === "number" && mirror.rev > change.rev) {
    outcome = "stale";
  } else if (change.current === null) {
    await tx.objectStore(change.entity).delete(change.entity_key);
  } else {
    await tx.objectStore(change.entity).put(change.current, change.entity_key);
  }
  await done;
  // A held change still says the server's rows moved, so the snapshot built on them is forgotten
  // too; only a stale echo, which this phone has already passed, changes nothing.
  if (outcome !== "stale") entityWritten(h, change.entity);
  return outcome;
}

/**
 * The cursor a pull starts from: before the first change it held for a row whose queue has since
 * emptied, so that change is read again — the op that owned the row may have settled without
 * reading it back (`duplicate`). Holds for rows still queued stay. The rewound cursor is STORED in
 * the transaction that drops the released holds: the pull saves its cursor only after a page
 * applies, so a first request that fails would otherwise leave the holds gone and the stored
 * cursor past the change they named (A168).
 */
export async function releasePullHolds(h: AccountHandle, cursor: number): Promise<number> {
  const db = await openAccountDb(h);
  const tx = db.transaction([OUTBOX_STORE, META_STORE], "readwrite");
  const meta = tx.objectStore(META_STORE);
  const [holds, ops] = await Promise.all([
    meta.get(PULL_HOLDS_KEY) as Promise<Holds | undefined>,
    tx.objectStore(OUTBOX_STORE).getAll() as Promise<OutboxOp[]>,
  ]);
  assertCurrent(h);
  if (!holds || Object.keys(holds).length === 0) {
    await tx.done;
    return cursor;
  }
  const queued = new Set(ops.map(rowKey));
  const kept: Holds = {};
  let from = cursor;
  for (const [key, seq] of Object.entries(holds)) {
    if (queued.has(key)) kept[key] = seq;
    else from = Math.min(from, seq - 1);
  }
  await meta.put(kept, PULL_HOLDS_KEY);
  if (from < cursor) await meta.put(from, CURSOR_KEY);
  await tx.done;
  return from;
}
