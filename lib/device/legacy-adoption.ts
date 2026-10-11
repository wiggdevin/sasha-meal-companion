/**
 * First boot of the Phase 9 build on a phone that ran the old one (spec §0.6; plan decision P3).
 *
 * The old build kept every account in one database, `smc`, and in unprefixed storage keys. Only
 * what PROVES its owner moves into the bound account's own database: rows whose `user_id` is this
 * account, the owner-keyed eaten marker, and pending records stamped with this owner. Nothing else
 * is ever read into an account:
 *  - outbox ops carry no owner, so they are HELD in `smc`: counted, never stamped, sent or shown;
 *  - `smc` is never deleted in this slice (PR #248 review r5 #2): an old tab can still write
 *    into it; deleting it is a later, separately reviewed step;
 *  - old unprefixed caches are deleted (the server has them); drafts, scans, coach transcripts,
 *    coach-action marks and the store blob are moved under `smc:legacy:` and held (never shown,
 *    never sent — audit plan r3 finding 2: the blob carries no owner). They are held even on a
 *    phone with one recorded owner (PR #248 review r1 #1): another account can have left
 *    local-only data with no owner on record.
 *    Trade-off: Today history that exists only in the old blob stays hidden until a later
 *    server-side rebuild restores it.
 */
import { openDB, type IDBPDatabase } from "idb";
import { AccountChanged, assertCurrent, type AccountHandle } from "./account";
import {
  getMeta, getRow, LEGACY_DB_NAME, META_STORE, openAccountDb, OUTBOX_STORE, putMeta, putRow,
} from "@/lib/sync/idb";
import { ENTITIES } from "@/lib/sync/types";
import { withWeighInLock } from "@/lib/health/weigh-in-client";
// The records' own lock (PR #248 review r6 #3).
import { serialize as withPendingRecordsLock } from "@/lib/log/pending";
import { withTargetQueueLock } from "@/lib/targets/client";

export const LEGACY_PREFIX = "smc:legacy:";
const ADOPTED_PREFIX = "smc:device:legacy-adopted:";
/** One device-level mark per held op the owner recovered: `<prefix><op_id>` → the account it went to. */
export const RECOVERED_PREFIX = "smc:device:legacy-recovered:";

/** The account a held op was recovered into, or null while it is still held. */
export function legacyOpRecoveredBy(opId: string): string | null {
  try { return localStorage.getItem(`${RECOVERED_PREFIX}${opId}`); } catch { return null; }
}
const EATEN_MARKER_PREFIX = "grandfathered_eaten:";

type Lock = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * The three durable queues whose records carry the account that made them, the owner field, and
 * the lock their own writers hold (PR #248 review r6 #3: adoption merges under that same lock).
 */
const OWNED_QUEUES: readonly { key: string; owner: string; id: (r: Rec) => unknown; lock: Lock }[] = [
  { key: "pending_log_entries", owner: "userId", id: (r: Rec) => r.entryId,
    lock: withPendingRecordsLock },
  { key: "pending_weigh_ins", owner: "userId",
    id: (r: Rec) => (r.request as Rec | undefined)?.localDate, lock: withWeighInLock },
  { key: "pending_target_revisions", owner: "ownerId", id: (r: Rec) => r.requestId,
    lock: withTargetQueueLock },
];

type Rec = Record<string, unknown>;

export const HELD_LINE = (n: number): string =>
  `${n} changes from before the update are held on this phone.`;

/**
 * Opens `smc` only if it exists: a phone that never had it gets no empty database made for it.
 * Existence comes from `indexedDB.databases()`, so nothing is ever created or deleted here. A
 * browser without that API (or one that fails it) answers "unknown": adoption is skipped, the old
 * data stays untouched, and nothing is recorded as done (PR #248 review r6 #6).
 */
export async function openLegacy(): Promise<IDBPDatabase | null | "unknown"> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return "unknown";
  let names: (string | undefined)[];
  try {
    names = (await indexedDB.databases()).map((d) => d.name);
  } catch {
    return "unknown";
  }
  if (!names.includes(LEGACY_DB_NAME)) return null;
  // No version: opens whatever version the old build left, and never upgrades it.
  return openDB(LEGACY_DB_NAME);
}

async function legacyMeta(db: IDBPDatabase): Promise<Map<string, unknown>> {
  if (!db.objectStoreNames.contains(META_STORE)) return new Map();
  const keys = await db.getAllKeys(META_STORE);
  const values = await db.getAll(META_STORE);
  return new Map(keys.map((k, i) => [String(k), values[i] as unknown]));
}

/** Rule 2: rows stamped with this account, into empty keys only. */
async function copyOwnedRows(h: AccountHandle, db: IDBPDatabase): Promise<number> {
  let copied = 0;
  for (const entity of ENTITIES) {
    if (!db.objectStoreNames.contains(entity)) continue;
    const keys = await db.getAllKeys(entity);
    const rows = await db.getAll(entity) as Rec[];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const key = keys[i];
      if (row?.user_id !== h.userId || typeof key !== "string") continue;
      if (await getRow(h, entity, key) !== undefined) continue;
      await putRow(h, entity, key, row);
      copied += 1;
    }
  }
  return copied;
}

/** Rule 3: the owner-keyed eaten marker, so a finished migration stays recorded. */
async function copyEatenMarker(h: AccountHandle, meta: Map<string, unknown>): Promise<number> {
  const key = `${EATEN_MARKER_PREFIX}${h.userId}`;
  if (!meta.has(key) || await getMeta(h, key) !== undefined) return 0;
  await putMeta(h, key, meta.get(key));
  return 1;
}

/** Rule 4a: this owner's pending records, merged by their id; a record already here wins. */
async function adoptOwnedRecords(h: AccountHandle, meta: Map<string, unknown>): Promise<number> {
  let adopted = 0;
  for (const queue of OWNED_QUEUES) {
    const legacy = meta.get(queue.key);
    if (!Array.isArray(legacy)) continue;
    const mine = (legacy as Rec[]).filter((r) => r?.[queue.owner] === h.userId);
    if (mine.length === 0) continue;
    adopted += await queue.lock(() => mergeOwned(h, queue.key, mine, queue.id));
  }
  return adopted;
}

/** Read, merge and write one queue in ONE readwrite transaction; a record already here wins. */
async function mergeOwned(
  h: AccountHandle, key: string, mine: Rec[], id: (r: Rec) => unknown,
): Promise<number> {
  const db = await openAccountDb(h);
  assertCurrent(h);
  const tx = db.transaction(META_STORE, "readwrite");
  const current = await tx.store.get(key) as unknown;
  const held = Array.isArray(current) ? current as Rec[] : [];
  const known = new Set(held.map(id));
  const fresh = mine.filter((r) => !known.has(id(r)));
  if (fresh.length > 0) await tx.store.put([...held, ...fresh], key);
  await tx.done;
  return fresh.length;
}

/** Rule 5: unsent work in `smc` — outbox rows plus every `pending_*` meta record. */
function pendingRecordCount(meta: Map<string, unknown>, heldOnly: (owner: unknown) => boolean): number {
  let n = 0;
  for (const [key, value] of meta) {
    if (!key.startsWith("pending_")) continue;
    const queue = OWNED_QUEUES.find((q) => q.key === key);
    const list = Array.isArray(value) ? value as Rec[] : value === undefined ? [] : [value as Rec];
    n += queue ? list.filter((r) => heldOnly(r?.[queue.owner])).length : list.length;
  }
  return n;
}

function adoptedOnThisPhone(owner: unknown): boolean {
  if (typeof owner !== "string") return false;
  try { return localStorage.getItem(`${ADOPTED_PREFIX}${owner}`) === "1"; } catch { return false; }
}

/** Rule 6: delete old re-fetchable caches; hold drafts, scans, coach data and the store blob. */
function sweepLegacyStorage(): void {
  let store: Storage;
  try { store = localStorage; } catch { return; }
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key !== null) keys.push(key);
  }
  for (const key of keys) {
    if (isDroppedCache(key)) { store.removeItem(key); continue; }
    if (!isHeld(key)) continue;
    const target = `${LEGACY_PREFIX}${key}`;
    // Never overwrite something already held: a second old blob stays where it is, unread.
    if (store.getItem(target) !== null) continue;
    try {
      store.setItem(target, store.getItem(key) ?? "");
      store.removeItem(key);
    } catch { /* storage full: the key stays where it is, unread by the new build */ }
  }
}

function isDroppedCache(key: string): boolean {
  return ["smc:health_daily", "smc:expenditure", "smc:proposals", "meal-companion:food-refs",
    "meal-companion:onboardingInviteDismissedAt"].includes(key);
}

/**
 * Ownerless data the server cannot give back. Old coach transcripts and action marks are held too
 * (PR #248 review r2 #3): they record applied results and Undo tokens. The thread pointers
 * (`smc:coach:current:*`, `smc:coach:return`) stay where they are, as before.
 */
function isHeld(key: string): boolean {
  if (key.startsWith("smc:coach:current:") || key === "smc:coach:return") return false;
  return key.startsWith("smc:draft:") || key === "smc:pending_scans"
    || key === "meal-companion:store:v1"
    || key.startsWith("smc:coach:") || key.startsWith("smc:coach-action:");
}

/**
 * Steps 1–4 against the legacy database. Returns what was copied and how many ops are held.
 * `smc` is never deleted in this slice (PR #248 review r5 #2): an old tab can still write into it
 * after any count. Deleting it is a later, separately reviewed step.
 */
async function adoptFromDb(h: AccountHandle, db: IDBPDatabase): Promise<{
  copied: number; heldOps: number;
}> {
  const meta = await legacyMeta(db);
  const firstTime = !adoptedOnThisPhone(h.userId);
  let copied = 0;
  if (firstTime) copied += await copyOwnedRows(h, db) + await copyEatenMarker(h, meta);
  copied += await adoptOwnedRecords(h, meta);
  const heldOps = db.objectStoreNames.contains(OUTBOX_STORE) ? await db.count(OUTBOX_STORE) : 0;
  return { copied, heldOps };
}

/**
 * Runs between bind and ready. `AccountChanged` ends it quietly (the next bind runs it again); any
 * other error rejects (no catch-all) and the gate decides what to show.
 */
export async function adoptLegacyDevice(
  h: AccountHandle,
): Promise<{ copied: number; heldOps: number }> {
  try {
    assertCurrent(h);
    const db = await openLegacy();
    let result = { copied: 0, heldOps: 0 };
    if (db !== null && db !== "unknown") {
      try { result = await adoptFromDb(h, db); } finally { db.close(); }
    }
    assertCurrent(h);
    sweepLegacyStorage();
    // Only a check that answered may record the adoption as done; "unknown" repeats next time.
    if (db !== "unknown") {
      try { localStorage.setItem(`${ADOPTED_PREFIX}${h.userId}`, "1"); } catch { /* next boot repeats */ }
    }
    return { copied: result.copied, heldOps: result.heldOps };
  } catch (e) {
    if (e instanceof AccountChanged) return { copied: 0, heldOps: 0 };
    throw e;
  }
}

/** Unsent work the old build left on this phone that no account here has adopted. 0 with no `smc`. */
export async function legacyHeldCount(): Promise<number> {
  const db = await openLegacy();
  if (db === null || db === "unknown") return 0;
  try {
    // An op the owner recovered into an account (lib/device/legacy-recovery.ts) is no longer held.
    const keys = db.objectStoreNames.contains(OUTBOX_STORE) ? await db.getAllKeys(OUTBOX_STORE) : [];
    const ops = keys.filter((k) => legacyOpRecoveredBy(String(k)) === null).length;
    return ops + pendingRecordCount(await legacyMeta(db), (owner) => !adoptedOnThisPhone(owner));
  } finally {
    db.close();
  }
}
