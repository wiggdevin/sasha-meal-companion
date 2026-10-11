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
 *   (`hasQueuedAfter`): the mirror already holds the newer intent.
 * - A pulled row is held, not written, while an op for it is queued (`putPulledRow`), and the
 *   change it carried is read again once the row's queue is empty (`releasePullHolds`), so a skip
 *   never loses another device's change when the op settles without reading the row back.
 *
 * `user_settings` and `food_membership` keep their own rules (lib/sync/settings.ts,
 * lib/sync/outbox-membership.ts) and are outside all three.
 */
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import {
  META_STORE, OUTBOX_STORE, openAccountDb, outboxRow, type OutboxOp, type QueuedSyncOp,
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

export async function hasQueuedAfter(h: AccountHandle, op: OutboxOp): Promise<boolean> {
  if (OWN_RULES.has(op.entity)) return false;
  const db = await openAccountDb(h);
  const all = (await db.getAll(OUTBOX_STORE)) as OutboxOp[];
  assertCurrent(h);
  return queuedAfter(all, op).length > 0;
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
  const db = await openAccountDb(h);
  const tx = db.transaction([refused.entity, OUTBOX_STORE], "readwrite");
  const done = tx.done;
  try {
    assertCurrent(h);
    const outbox = tx.objectStore(OUTBOX_STORE);
    for (const id of [refused.op_id, ...retire]) await outbox.delete(id);
    await tx.objectStore(refused.entity).put(mirror, refused.entity_id);
    await outbox.put(outboxRow(h, next, refused.seq, now));
    await done;
  } catch (error) {
    try { tx.abort(); } catch { /* already finished */ }
    await done.catch(() => undefined);
    throw error;
  }
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
 * Write a pulled row into the mirror, unless the row is this phone's to settle: an op for it is
 * queued (held, and remembered), or the mirror already holds a later revision (stale). One
 * transaction over the row, the outbox and the meta store, so a write queued meanwhile is seen.
 */
export async function putPulledRow(
  h: AccountHandle, change: ChangeRow & { current: Record<string, unknown> },
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
  } else {
    await tx.objectStore(change.entity).put(change.current, change.entity_key);
  }
  await done;
  return outcome;
}

/**
 * The cursor a pull starts from: before the first change it held for a row whose queue has since
 * emptied, so that change is read again — the op that owned the row may have settled without
 * reading it back (`duplicate`). Holds for rows still queued stay.
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
  await tx.done;
  return from;
}
