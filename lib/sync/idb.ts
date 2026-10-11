/**
 * The client store — architecture §3.7. One object store per synced entity, keyed by the
 * `entity_key` of contracts §4, so a pulled `ChangeRow.current` writes straight in. Plus an
 * `outbox` of pending ops and a `meta` store holding the change cursor.
 *
 * Phase 9 §0.2: one database per account (`smc-u-<userId>`). Every primitive takes the
 * `AccountHandle` of the work that started it and checks it before it writes and after it reads,
 * so work that started as one account never lands in, or reads from, another.
 */
import { openDB, type IDBPDatabase } from "idb";
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
export type { AccountHandle };
import { encodeKey } from "./keys";
import { ENTITIES, type Entity, type SyncOp } from "./types";

/** The pre-Phase-9 shared database. Read only by lib/device/legacy-adoption.ts (spec §0.6). */
export const LEGACY_DB_NAME = "smc";
export const ACCOUNT_DB_PREFIX = "smc-u-";
/** v1 of the per-account database: the same upgrade loop over ENTITIES, run once from empty. */
export const DB_VERSION = 1;
export const OUTBOX_STORE = "outbox";
export const META_STORE = "meta";
/** Phase 2: cached catalog revisions (contracts 1–2 §5), keyed by revision_id. */
export const CATALOG_STORE = "catalog_revisions";

export const CURSOR_KEY = "cursor";
const LAST_SYNC_KEY = "last_sync_at";
/** This device's queue counter. Exported so a settlement can allocate a seq inside its own
 *  transaction (lib/sync/settings.ts) instead of opening a second one. */
export const OUTBOX_SEQ_KEY = "outbox_seq";
const LAST_ERROR_KEY = "last_error";

export function accountDbName(userId: string): string { return `${ACCOUNT_DB_PREFIX}${userId}`; }

/** The stamped op (plan decision P1): what an outbox row holds and what goes on the wire. The
 *  server refuses an op whose `user_id` is missing or is not the JWT subject (spec §0.5). */
export type OwnedOp = SyncOp & { user_id: string };

/** The outbox row: the op itself, plus this device's queue order and its retry state. `attempts`
 *  counts transport failures (offline, 5xx); `error_attempts` counts the server rejecting this op
 *  specifically. They are separate so a weekend offline never spends the park budget. */
export type OutboxOp = OwnedOp & {
  seq: number; attempts: number; error_attempts: number;
  queued_at: string; next_attempt_at: number;
  /** Settings generations (lib/sync/settings.ts): the frozen intent snapshot and the generation
   *  number. Device bookkeeping only — `wireOp` strips both before an op goes on the wire. */
  intents?: { key: string; value: unknown; sub?: string[]; delta?: { add: string[]; remove: string[] } }[];
  generation?: number;
  /** A whole-note edit (a log entry's note): the note the edit started from, so a conflict can
   *  tell the user's change from the server's (lib/sync/log-entry-ops.ts). Device bookkeeping only:
   *  `wireOp` strips it. `null` is "no note"; absent is an op queued before this field existed. */
  note_base?: string | null;
  /** A field-wise edit (a `plan_days` op): each payload field's value in the mirror the edit
   *  started from, so a conflict merges slot by slot what the user changed (lib/sync/merge.ts
   *  `mergePlanDayFields`). Device bookkeeping only: `wireOp` strips it. */
  base_fields?: Record<string, unknown>;
  /** A rebased field-wise edit: when the user made each field or slot it still carries, so the next
   *  conflict compares that edit's own time, not the rebase's (lib/sync/merge.ts `planDayStamps`).
   *  Device bookkeeping only: `wireOp` strips it. */
  field_stamps?: Record<string, string>;
};

/** A queued op with the bookkeeping its writer may attach at queue time. */
export type QueuedSyncOp = SyncOp & Pick<OutboxOp, "note_base" | "base_fields" | "field_stamps">;

/** The store layout, shared by the per-account database and the legacy database. */
export function upgradeStores(db: IDBPDatabase): void {
  for (const entity of ENTITIES) {
    if (!db.objectStoreNames.contains(entity)) db.createObjectStore(entity);
  }
  if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
    db.createObjectStore(OUTBOX_STORE, { keyPath: "op_id" })
      .createIndex("by_seq", "seq", { unique: true });
  }
  if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
  if (!db.objectStoreNames.contains(CATALOG_STORE)) {
    db.createObjectStore(CATALOG_STORE, { keyPath: "revision_id" })
      .createIndex("by_cached_at", "cached_at");
  }
}

const dbs = new Map<string, Promise<IDBPDatabase>>();

/** Keyed by user id. A rejected open is not cached, or one failed open wedges sync for the whole
 *  session. The handle is checked before the open and after it resolves. */
export async function openAccountDb(h: AccountHandle): Promise<IDBPDatabase> {
  assertCurrent(h);
  let p = dbs.get(h.userId);
  if (!p) {
    p = openDB(accountDbName(h.userId), DB_VERSION, { upgrade: upgradeStores })
      .catch((e: unknown) => { dbs.delete(h.userId); throw e; });
    dbs.set(h.userId, p);
  }
  const db = await p;
  assertCurrent(h);
  return db;
}

/** Waits for the open to settle, then closes it (open transactions finish first). */
export async function closeAccountDb(userId: string): Promise<void> {
  const p = dbs.get(userId);
  if (!p) return;
  dbs.delete(userId);
  (await p.catch(() => null))?.close();
}

/**
 * The departure's durability barrier (lib/device/departure.ts): one readwrite transaction over
 * every store commits only after every transaction this page started earlier on that database
 * (IndexedDB runs overlapping readwrite transactions in creation order). Rejects when it cannot
 * commit. `close` (after the freeze, when no new transaction can start) also closes the connection.
 */
export async function settleAccountDb(userId: string, opts: { close?: boolean } = {}): Promise<void> {
  const p = dbs.get(userId);
  if (!p) return; // this page never opened it: nothing of it is in flight
  const db = await p.catch(() => null);
  if (!db) { dbs.delete(userId); return; } // it never opened, so nothing was written through it
  const names = [...db.objectStoreNames];
  // A barrier that fails keeps the connection, so Retry runs it again.
  if (names.length > 0) await db.transaction(names, "readwrite").done;
  if (!opts.close) return;
  dbs.delete(userId);
  db.close();
}

export async function closeAllAccountDbs(): Promise<void> {
  await Promise.all([...dbs.keys()].map(closeAccountDb));
}

/** The check that matters: after every await, immediately before the request that writes. */
async function write(h: AccountHandle, fn: (db: IDBPDatabase) => Promise<unknown>): Promise<void> {
  const db = await openAccountDb(h);
  assertCurrent(h);
  await fn(db);
}

/** Every read checks the handle AFTER the request resolves (audit plan r2 finding 7): a read that
 *  started as A and finishes after B binds returns nothing to its caller. */
async function read<T>(h: AccountHandle, fn: (db: IDBPDatabase) => Promise<unknown>): Promise<T> {
  const value = await fn(await openAccountDb(h));
  assertCurrent(h);
  return value as T;
}

// ---------- Phase 17 O2: the meal snapshot's watermark (lib/foods/meal-snapshot-store.ts) ----------

export const MEAL_SNAPSHOT_KEY = "meal_snapshot_v2";
/** Moves on every change to a snapshot input, in the same transaction as the change. */
export const MEAL_SNAPSHOT_EPOCH_KEY = "meal_snapshot_epoch";
/**
 * The local rows a meal snapshot was computed from. ONE hook: every write this module makes to
 * one of them (a log committed, edited, moved or deleted; a pull of another device's log; a coach
 * apply or undo; an Eats or settings change) forgets the snapshot, whichever call site wrote it.
 */
export const SNAPSHOT_INPUTS: ReadonlySet<string> = new Set(
  ["log_entries", "user_settings", "user_food_prefs", "user_foods", "food_membership"]);

type MetaRequests = {
  get(key: string): Promise<unknown>;
  put(value: unknown, key: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};

/**
 * This page's count of snapshot-input writes per account. A held eligible set notes it when made
 * and stops offering its history once it moves (lib/foods/eligible-client.ts), synchronously,
 * without waiting for a re-read (Sol r4 WARN 3). Counted when the write is issued: a write that
 * then fails only costs a re-read.
 */
const inputWrites = new Map<string, number>();
export function snapshotInputWrites(userId: string): number { return inputWrites.get(userId) ?? 0; }
const bump = (userId: string) => inputWrites.set(userId, snapshotInputWrites(userId) + 1);
/** Other tabs of this origin hear of a write too (Sol r5 WARN 4); a tab never hears its own. */
const inputChannel: BroadcastChannel | null = typeof BroadcastChannel === "function"
  ? new BroadcastChannel("meal-snapshot-inputs") : null;
if (inputChannel) {
  inputChannel.onmessage = (event: MessageEvent) => {
    const userId = (event.data as { userId?: unknown } | null)?.userId;
    if (typeof userId === "string") bump(userId);
  };
  // Never keep a process (tests, a worker) alive for this.
  (inputChannel as unknown as { unref?: () => void }).unref?.();
}
function noteSnapshotInputWrite(h: AccountHandle): void {
  bump(h.userId);
  try { inputChannel?.postMessage({ userId: h.userId }); } catch { /* a closed channel: this tab still counts */ }
}

/** Tests only: what another tab's write delivers here. */
export function receiveSnapshotInputWriteForTests(userId: string): void { bump(userId); }

async function forgetSnapshotIn(meta: MetaRequests): Promise<void> {
  const epoch = Number(await meta.get(MEAL_SNAPSHOT_EPOCH_KEY) ?? 0);
  await meta.put((Number.isFinite(epoch) ? epoch : 0) + 1, MEAL_SNAPSHOT_EPOCH_KEY);
  await meta.delete(MEAL_SNAPSHOT_KEY);
}

/**
 * After a snapshot-input write: count it now (synchronously, this tab and the others) and forget
 * the stored snapshot in its OWN transaction, a macrotask later and never awaited. The write being
 * made — a commit's local-first mirror, the outbox write a deadline falls back to — must not wait
 * on this: META requests inside its transaction, or a META transaction queued ahead of the
 * commit's own META writes, kept the request from going out before the deadline was armed
 * (PR #392 CI, tests/speed/deadlines.test.ts). A snapshot answer that races the gap is caught by the count
 * (lib/foods/eligible-client.ts) and by the persisted watermark this moves.
 */
const pendingForget = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Run a scheduled forget now and wait for it. Snapshot readers and writers call this (never the
 * commit path), so they always compare against the watermark every earlier write moved.
 */
export async function settleSnapshotForget(h: AccountHandle): Promise<void> {
  const timer = pendingForget.get(h.userId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingForget.delete(h.userId);
  await forgetMealSnapshot(h, false).catch(() => undefined);
}
function snapshotInputWritten(h: AccountHandle): void {
  noteSnapshotInputWrite(h);
  // A macrotask later, once per burst of writes: the caller's own next IndexedDB steps (the
  // pending mark and outbox seq in META, the request going out) go first.
  if (pendingForget.has(h.userId)) return;
  pendingForget.set(h.userId, setTimeout(() => {
    pendingForget.delete(h.userId);
    void forgetMealSnapshot(h, false).catch(() => undefined);
  }, 0));
}

/** After a committed write to `entity` made in a transaction of the caller's own: a snapshot
 *  input forgets the snapshot, exactly as `writeEntity` does (lib/sync/row-queue.ts). */
export function entityWritten(h: AccountHandle, entity: string): void {
  if (SNAPSHOT_INPUTS.has(entity)) snapshotInputWritten(h);
}

/** A write to `entity`; a snapshot input also forgets the snapshot, after and apart from it. */
async function writeEntity(h: AccountHandle, entity: Entity,
  fn: (store: { put(value: unknown, key: string): Promise<unknown>; delete(key: string): Promise<unknown> }) =>
    Promise<unknown>): Promise<void> {
  const db = await openAccountDb(h);
  assertCurrent(h);
  const tx = db.transaction(entity, "readwrite");
  await fn(tx.objectStore(entity) as never);
  await tx.done;
  if (SNAPSHOT_INPUTS.has(entity)) snapshotInputWritten(h);
}

/** Forget the snapshot now (a rules change the phone holds no row for). */
export async function forgetMealSnapshot(h: AccountHandle, count = true): Promise<void> {
  if (count) noteSnapshotInputWrite(h);
  await write(h, async (db) => {
    const tx = db.transaction(META_STORE, "readwrite");
    await forgetSnapshotIn(tx.objectStore(META_STORE) as unknown as MetaRequests);
    await tx.done;
  });
}

/** The watermark a snapshot read starts under. */
export async function mealSnapshotEpoch(h: AccountHandle): Promise<number> {
  const value = Number(await read<unknown>(h, (db) => db.get(META_STORE, MEAL_SNAPSHOT_EPOCH_KEY)) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Store a snapshot only if nothing it was computed from changed since its read started (the
 * watermark is persistent and shared by every tab, so another tab's change or a reload counts).
 */
export async function putMealSnapshotIfCurrent(h: AccountHandle, value: unknown, epoch: number): Promise<boolean> {
  let stored = false;
  await write(h, async (db) => {
    const tx = db.transaction(META_STORE, "readwrite");
    const meta = tx.objectStore(META_STORE);
    const current = Number(await meta.get(MEAL_SNAPSHOT_EPOCH_KEY) ?? 0);
    if (current === epoch) {
      await meta.put(value, MEAL_SNAPSHOT_KEY);
      stored = true;
    }
    await tx.done;
  });
  return stored;
}

export async function putRow(
  h: AccountHandle, entity: Entity, key: string, row: Record<string, unknown>,
): Promise<void> {
  await writeEntity(h, entity, (store) => store.put(row, key));
}

export async function getRow(
  h: AccountHandle, entity: Entity, key: string,
): Promise<Record<string, unknown> | undefined> {
  return read(h, (db) => db.get(entity, key));
}

export async function deleteRow(h: AccountHandle, entity: Entity, key: string): Promise<void> {
  await writeEntity(h, entity, (store) => store.delete(key));
}

export async function allRows(h: AccountHandle, entity: Entity): Promise<Record<string, unknown>[]> {
  return read(h, (db) => db.getAll(entity));
}

/** One meta value of this account's database. */
export async function getMeta<T>(h: AccountHandle, key: string): Promise<T | undefined> {
  return read(h, (db) => db.get(META_STORE, key));
}

export async function putMeta(h: AccountHandle, key: string, value: unknown): Promise<void> {
  await write(h, (db) => db.put(META_STORE, value, key));
}

export async function deleteMeta(h: AccountHandle, key: string): Promise<void> {
  await write(h, (db) => db.delete(META_STORE, key));
}

/** The queue number, this device's retry state, the owner and the op — one outbox row. */
export function outboxRow(h: AccountHandle, op: QueuedSyncOp, seq: number, now: number): OutboxOp {
  return {
    ...op, user_id: h.userId, seq, attempts: 0, error_attempts: 0,
    queued_at: new Date(now).toISOString(), next_attempt_at: now,
  };
}

/** Strip this device's queue bookkeeping; the op and its owner go on the wire (spec §0.5). */
export function wireOp(op: OutboxOp): OwnedOp {
  const { seq, attempts, error_attempts, queued_at, next_attempt_at, intents, generation,
    note_base, base_fields, field_stamps, ...rest } = op;
  void seq; void attempts; void error_attempts; void queued_at; void next_attempt_at;
  void intents; void generation; void note_base; void base_fields; void field_stamps;
  return rest;
}

/** Allocates this device's next queue number and stores the op in the same transaction. */
export async function appendOp(
  h: AccountHandle, op: SyncOp, now: number = Date.now(),
): Promise<OutboxOp> {
  return writeOp(h, op, null, now);
}

/**
 * The same, with the entity's mirror row committed alongside the op. A row and its op are two
 * halves of one change — the mirror is what the UI reads and what a conflict merges against, and
 * the op is the only record of what the user meant — so a crash between two separate writes would
 * leave a row the server never hears about.
 *
 * There is no separate entity/key argument: both come from the op, and the row must key to the same
 * place. A mismatch is a caller bug, and it throws before the transaction opens rather than writing
 * a row under a key that does not describe it.
 */
export async function appendOpWithRow(
  h: AccountHandle, row: Record<string, unknown>, op: QueuedSyncOp, now: number = Date.now(),
  precondition?: QueuePrecondition,
): Promise<OutboxOp> {
  const rowKey = encodeKey(op.entity, row);
  if (rowKey !== op.entity_id) {
    throw new TypeError(
      `${op.entity}: row key ${rowKey} does not match op entity_id ${op.entity_id}`,
    );
  }
  return writeOp(h, op, { entity: op.entity, key: rowKey, row, precondition }, now);
}

/**
 * Checked inside the write's own transaction, against the queued ops and the row it replaces: a
 * throw aborts the write. A caller that built its op from earlier, separate reads uses it to refuse
 * a write those reads no longer describe (lib/log-note-client.ts).
 */
export type QueuePrecondition = (reads: {
  ops: OutboxOp[]; current: Record<string, unknown> | undefined;
}) => void;

/** The mirror row, when there is one, rides the outbox transaction. */
type Mirror = {
  entity: Entity; key: string; row: Record<string, unknown>; precondition?: QueuePrecondition;
} | null;

/**
 * What one `mutateRowWithOp` write returns. `retire` names ops this write REPLACES — a coalesced
 * settings op — and `meta` carries the bookkeeping that belongs with the row (the settings
 * baseline and its field intents). Both are written inside the same transaction as the row and its
 * op, so a reader can never see the new row next to the old op or the old baseline.
 */
export type RowWrite<T> = {
  row: Record<string, unknown>;
  op: SyncOp;
  result: T;
  retire?: readonly string[];
  meta?: readonly { key: string; value: unknown }[];
};

/** What the callback can read inside the write's own transaction: the other queued ops, and the
 *  meta store's current contents. The settings row's whole-row intent model needs both (it folds
 *  the ops it coalesces and rebases the baseline), and reading them outside the transaction would
 *  be the lost-update bug this helper exists to prevent. */
export type RowReads = { ops: OutboxOp[]; meta: ReadonlyMap<string, unknown> };

/** Aborts `tx` after a throw that may not have reached a request, and settles `done`. */
async function abortQuietly(tx: { abort(): void }, done: Promise<void>): Promise<void> {
  try { tx.abort(); } catch { /* already aborted or finished */ }
  await done.catch(() => undefined);
}

/**
 * One row per `op_id`, always. The store is keyed on it, so a repeat enqueue of the same op
 * replaces rather than duplicates — which matters because `drainOutbox` keys its results by
 * op_id and a second row sharing one would go silently unanswered.
 *
 * A repeat keeps the FIRST row's place in the queue and the backoff it has been earning: a commit
 * that keeps timing out re-offers the same op (T0 §3 queues it before every post), and taking a
 * fresh seq each time would let a failing op jump ahead of everything queued behind it and reset
 * its own retry delay. Only the payload is new.
 */
async function writeOp(h: AccountHandle, op: QueuedSyncOp, mirror: Mirror, now: number): Promise<OutboxOp> {
  const db = await openAccountDb(h);
  const stores = mirror ? [mirror.entity, OUTBOX_STORE, META_STORE] : [OUTBOX_STORE, META_STORE];
  const tx = db.transaction(stores, "readwrite");
  const done = tx.done;
  try {
    const outbox = tx.objectStore(OUTBOX_STORE);
    const existing = (await outbox.get(op.op_id)) as OutboxOp | undefined;
    // Phase 9 §0.2: nothing lands after a switch. A throw here aborts the whole transaction.
    assertCurrent(h);
    const meta = tx.objectStore(META_STORE);
    let seq: number;
    if (existing) {
      seq = existing.seq;
    } else {
      seq = (((await meta.get(OUTBOX_SEQ_KEY)) as number | undefined) ?? 0) + 1;
      await meta.put(seq, OUTBOX_SEQ_KEY);
    }
    if (mirror?.precondition) {
      mirror.precondition({
        ops: (await outbox.getAll()) as OutboxOp[],
        current: (await tx.objectStore(mirror.entity).get(mirror.key)) as
          Record<string, unknown> | undefined,
      });
    }
    if (mirror) await tx.objectStore(mirror.entity).put(mirror.row, mirror.key);
    const fresh = outboxRow(h, op, seq, now);
    const row: OutboxOp = existing
      ? { ...fresh, attempts: existing.attempts, error_attempts: existing.error_attempts,
          next_attempt_at: existing.next_attempt_at, queued_at: existing.queued_at }
      : fresh;
    await outbox.put(row);
    await done;
    if (SNAPSHOT_INPUTS.has(op.entity)) snapshotInputWritten(h);
    return row;
  } catch (error) {
    await abortQuietly(tx, done);
    throw error;
  }
}

/**
 * Read → mutate → write, all inside ONE readwrite transaction: the row `mutate` is handed is the
 * row this write replaces, and the mirror row and the op that describes it commit together.
 *
 * This is the fix for a read-modify-write that two writers can interleave (T11b audit finding 1):
 * `putRow` after a separate `getRow` is a lost update the moment a second writer — another screen,
 * or a pull applying the server's row — commits in between. IndexedDB runs one readwrite
 * transaction per store at a time, so a writer that has this transaction cannot be interrupted
 * between its read and its write, and the writer that runs second reads the first one's row.
 *
 * `mutate` may await, but ONLY requests of this transaction (`reads`): IndexedDB keeps a transaction
 * alive across the microtasks they resolve in, and anything read outside it would be stale by the
 * time the write lands. Anything else it needs belongs in the closure it was built with.
 *
 * The op's entity and key must BE the entity and key this write files under, and the row must key
 * to the same place (fifth-audit finding 5): the mirror row and the op are written to two stores
 * keyed by the caller's arguments, so an op naming a different record would commit half a change.
 */
export async function mutateRowWithOp<T>(
  h: AccountHandle, entity: Entity, key: string,
  mutate: (current: Record<string, unknown> | undefined, reads: RowReads) =>
    RowWrite<T> | Promise<RowWrite<T>>,
  now: number = Date.now(),
): Promise<T> {
  const db = await openAccountDb(h);
  const tx = db.transaction([entity, OUTBOX_STORE, META_STORE], "readwrite");
  const done = tx.done;
  try {
    const current = (await tx.objectStore(entity).get(key)) as
      Record<string, unknown> | undefined;
    // Every read the write needs happens HERE, inside the transaction that will replace what it
    // read; the callback receives them rather than opening a second transaction of its own.
    const ops = (await tx.objectStore(OUTBOX_STORE).getAll()) as OutboxOp[];
    const metaStore = tx.objectStore(META_STORE);
    const metaKeys = await metaStore.getAllKeys();
    const metaValues = await metaStore.getAll();
    const meta = new Map(metaKeys.map((k, i) => [String(k), metaValues[i] as unknown]));
    const { row, op, result, retire, meta: metaWrites } = await mutate(current, { ops, meta });
    assertCurrent(h);
    if (op.entity !== entity) {
      throw new TypeError(`${entity}: op entity ${op.entity} does not match ${entity}`);
    }
    if (op.entity_id !== key) {
      throw new TypeError(`${op.entity}: op entity_id ${op.entity_id} does not match ${key}`);
    }
    const rowKey = encodeKey(op.entity, row);
    if (rowKey !== key) {
      throw new TypeError(`${op.entity}: row key ${rowKey} does not match ${key}`);
    }
    const seq = (((await metaStore.get(OUTBOX_SEQ_KEY)) as number | undefined) ?? 0) + 1;
    await metaStore.put(seq, OUTBOX_SEQ_KEY);
    for (const id of retire ?? []) await tx.objectStore(OUTBOX_STORE).delete(id);
    for (const write of metaWrites ?? []) await metaStore.put(write.value, write.key);
    await tx.objectStore(entity).put(row, key);
    await tx.objectStore(OUTBOX_STORE).put(outboxRow(h, op, seq, now));
    await done;
    if (SNAPSHOT_INPUTS.has(entity)) snapshotInputWritten(h);
    return result;
  } catch (error) {
    // IndexedDB aborts the transaction when a request fails, so a rejected op write takes the
    // mirror row with it; a throw that never reached a request would otherwise commit what was
    // already written, so abort explicitly too. Settle `done` so the abort is not an unhandled
    // rejection, and rethrow the caller's own error.
    await abortQuietly(tx, done);
    throw error;
  }
}

export async function putOp(h: AccountHandle, op: OutboxOp): Promise<void> {
  await write(h, (db) => db.put(OUTBOX_STORE, op));
}

export async function allOps(h: AccountHandle): Promise<OutboxOp[]> {
  return read(h, (db) => db.getAllFromIndex(OUTBOX_STORE, "by_seq"));
}

export async function deleteOp(h: AccountHandle, opId: string): Promise<void> {
  await write(h, (db) => db.delete(OUTBOX_STORE, opId));
}

export async function countOps(h: AccountHandle): Promise<number> {
  return read(h, (db) => db.count(OUTBOX_STORE));
}

export async function getCursor(h: AccountHandle): Promise<number> {
  return (await getMeta<number>(h, CURSOR_KEY)) ?? 0;
}

export async function setCursor(h: AccountHandle, seq: number): Promise<void> {
  await putMeta(h, CURSOR_KEY, seq);
}

export async function getLastSyncAt(h: AccountHandle): Promise<string | null> {
  return (await getMeta<string>(h, LAST_SYNC_KEY)) ?? null;
}

export async function setLastSyncAt(h: AccountHandle, iso: string): Promise<void> {
  await putMeta(h, LAST_SYNC_KEY, iso);
}

/** The last failure worth showing them, or null when the last pass succeeded. */
export async function getLastError(h: AccountHandle): Promise<string | null> {
  return (await getMeta<string>(h, LAST_ERROR_KEY)) ?? null;
}

export async function setLastError(h: AccountHandle, message: string | null): Promise<void> {
  if (message === null) await deleteMeta(h, LAST_ERROR_KEY);
  else await putMeta(h, LAST_ERROR_KEY, message);
}
