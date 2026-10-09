/**
 * One IndexedDB readwrite transaction over a favorites entity, the outbox and the meta store, for
 * the writes that must land together or not at all: a favorite's mirror row and its op (a tombstone
 * written before its delete op is a delete the server never hears of), and the per-account indexes
 * a saved meal keeps beside them. Reads made through the context see this transaction's own state,
 * so a read-modify-write here cannot interleave with another tab's.
 *
 * The callback may await ONLY the context's requests (IndexedDB keeps the transaction alive across
 * them). A throw aborts the whole transaction. The handle is checked before every write.
 */
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import {
  META_STORE, OUTBOX_SEQ_KEY, OUTBOX_STORE, openAccountDb, outboxRow,
} from "@/lib/sync/idb";
import { announceQueued } from "@/lib/sync/outbox";
import type { Entity, SyncOp } from "@/lib/sync/types";

export type FavoritesTx = {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  getAll(): Promise<Record<string, unknown>[]>;
  put(key: string, row: Record<string, unknown>): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  putMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  /** Queue an op in this transaction; its op must name this transaction's entity. */
  enqueue(op: SyncOp): Promise<void>;
};

export async function favoritesTx<T>(
  h: AccountHandle, entity: Entity, fn: (tx: FavoritesTx) => Promise<T>, now: number = Date.now(),
): Promise<T> {
  const db = await openAccountDb(h);
  const tx = db.transaction([entity, OUTBOX_STORE, META_STORE], "readwrite");
  const done = tx.done;
  const rows = tx.objectStore(entity);
  const meta = tx.objectStore(META_STORE);
  let queued = false;
  const ctx: FavoritesTx = {
    get: async (key) => (await rows.get(key)) as Record<string, unknown> | undefined,
    getAll: async () => (await rows.getAll()) as Record<string, unknown>[],
    put: async (key, row) => { assertCurrent(h); await rows.put(row, key); },
    getMeta: async <V>(key: string) => (await meta.get(key)) as V | undefined,
    putMeta: async (key, value) => { assertCurrent(h); await meta.put(value, key); },
    deleteMeta: async (key) => { assertCurrent(h); await meta.delete(key); },
    enqueue: async (op) => {
      if (op.entity !== entity) throw new TypeError(`${entity}: op entity ${op.entity} does not match`);
      assertCurrent(h);
      const seq = (((await meta.get(OUTBOX_SEQ_KEY)) as number | undefined) ?? 0) + 1;
      await meta.put(seq, OUTBOX_SEQ_KEY);
      await tx.objectStore(OUTBOX_STORE).put(outboxRow(h, op, seq, now));
      queued = true;
    },
  };
  try {
    const result = await fn(ctx);
    await done;
    if (queued) announceQueued();
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted or finished */ }
    await done.catch(() => undefined);
    throw error;
  }
}
