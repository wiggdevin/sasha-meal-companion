// lib/sync/settings.ts
/**
 * The TRANSACTION half of the `user_settings` row: the four entry points a writer, a pull and a drain
 * go through, each one read-modify-write over [user_settings, outbox, meta] in a single IndexedDB
 * transaction. The state they move — the baseline, its field intents and the generation in flight —
 * and the rules that govern it live in `./settings-intents.ts`, which has no database in it.
 *
 *  - `mutateSettingsRow`  one local edit, folded into the single pending generation
 *  - `selectAndFreezeSettings`  the drain's selection AND freeze, in ONE transaction
 *  - `settleUserSettings` applied / conflict / duplicate / drop / pull, in one transaction
 *  - `applyPulledUserSettings` / `clearPulledUserSettings` — the pull's two shapes
 *  - `establishEmptySettingsBaseline` — the pull found no row, so the queued payload IS the row to create
 *
 * A settlement that wrote the mirror and re-queued in two steps would let a writer read the
 * half-updated pair and queue a rev the rewritten op already owns, which is why every one of them is
 * a single transaction.
 */
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import {
  META_STORE, OUTBOX_SEQ_KEY, OUTBOX_STORE, getMeta, getRow, mutateRowWithOp, openAccountDb,
  outboxRow, type OutboxOp,
} from "./idb";
import {
  BASELINE_KEY, HELD_INTENTS_KEY, SETTINGS_ENTITY, USER_SETTINGS_KEY, confirmedWrite, diffIntents, inFlight,
  looseRecovery, nextState, normalizeBaseline, opKind, pendingRev, pendingSettingsOps, payloadOf,
  settledGeneration, settingsMirror, unconfirmedWrite, upgradeIntents, withFrozenIntents,
  type SettingsBaseline,
  type SettingsGeneration, type SettingsIntent, type SettingsOp, type SettingsRow, type SettingsSettlement,
} from "./settings-intents";
import type { SyncOp } from "./types";
import type { IDBPTransaction } from "idb";

const ENTITY = SETTINGS_ENTITY;

/** A parked op waits a year: the drain stops selecting it on its own, and only a pull (or "Sync
 *  now") brings it back. Shared with the outbox's own server-error park. */
export const PARK_MS = 365 * 24 * 60 * 60 * 1000;

export type { SettingsBaseline, SettingsIntent, SettingsRow, SettingsSettlement, SettingsOp }
  from "./settings-intents";
export { USER_SETTINGS_KEY, pendingSettingsOps } from "./settings-intents";

/** The three stores one settlement writes, as the transaction hands them out. */
type SettlementTx = IDBPTransaction<unknown, string[], "readwrite">;

/**
 * Phase 18 W5b-2: keep intents an older build froze that cannot be replayed safely (see
 * `frozenIntents`) beside the baseline, for review; never sent. Logged without their values.
 */
async function holdIntents(meta: { get(key: string): Promise<unknown>; put(value: unknown, key: string): Promise<unknown> },
    held: readonly SettingsIntent[]): Promise<void> {
  if (held.length === 0) return;
  const before = await meta.get(HELD_INTENTS_KEY);
  const list = Array.isArray(before) ? before : [];
  await meta.put([...list, ...held.map((intent) => ({ ...intent, heldAt: new Date().toISOString() }))],
    HELD_INTENTS_KEY);
  console.warn(`sync: held ${held.length} settings change(s) an older build queued: ${held.map((i) => i.key).join(", ")}`);
}

/** The stored baseline, or null when this device has never settled one. */
export async function readSettingsBaseline(h: AccountHandle): Promise<SettingsBaseline | null> {
  return normalizeBaseline(await getMeta(h, BASELINE_KEY));
}

/**
 * The atomic read-modify-write behind `mutateUserSettings` (lib/sync/outbox.ts): ONE transaction over
 * [user_settings, outbox, meta] that reads the mirror, the baseline and every queued op, folds this
 * writer's intent into the single pending op, and commits the mirror, that op and the baseline
 * together. The op it writes carries the writer's fresh `op_id`; every op it replaces is retired with
 * it, so the queue can never hold a successor whose `base_rev` is a rev only our own op would make.
 */
export async function mutateSettingsRow<T>(
  h: AccountHandle,
  mutate: (current: SettingsRow) => { row: SettingsRow; op: SyncOp; result: T },
  now: number = Date.now(),
): Promise<T> {
  return mutateRowWithOp(h, ENTITY, USER_SETTINGS_KEY, (current, reads) => {
    const mirror = (current ?? {}) as SettingsRow;
    const { op: writer, result } = mutate(mirror);
    const stored = normalizeBaseline(reads.meta.get(BASELINE_KEY));
    // Read-only here: the next freeze or settlement stores the upgrade (and anything it holds).
    const { queued } = withFrozenIntents(stored, pendingSettingsOps(reads.ops));
    const write = stored === null && queued.some((op) => op.base_rev !== null)
      ? unconfirmedWrite(queued, writer, result)
      : confirmedWrite(mirror, stored, queued, writer, result);
    return { row: write.row, op: write.op, result: write.result,
      retire: write.retire, meta: write.meta };
  }, now);
}

/**
 * This browser's IANA zone, or UTC when the platform will not name one (D1 §6.4).
 *
 * UTC is the neutral fallback the server also defaults to. Nothing in code names a region: the
 * zone an account keeps is the zone the account's own first device reported.
 */
export function resolvedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * First authenticated online open: queue this browser's zone onto `user_settings.time_zone`
 * (D1 §6.4), through the ordinary settings-intent path, so it travels with whatever else is
 * pending and settles under the same omit/keep rules.
 *
 * Idempotent by design. A row that already names a zone is left alone, so a second device — or a
 * later sign-in from a different country — never silently rewrites the account's zone, and a
 * repeated call queues nothing. Returns whether an intent was recorded.
 */
export async function captureTimeZone(
  h: AccountHandle, zone: string = resolvedTimeZone(), now: number = Date.now(),
): Promise<boolean> {
  const current = await getRow(h, ENTITY, USER_SETTINGS_KEY);
  const stored = current?.time_zone;
  if (typeof stored === "string" && stored.trim() !== "") return false;
  await mutateSettingsRow(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    return {
      row: { ...row, time_zone: zone },
      // One key, so `foldEdit` records exactly one intent: the zone. Every other column stays
      // whatever the baseline and the pending generation already say it is.
      op: {
        op_id: crypto.randomUUID(), entity: ENTITY, entity_id: USER_SETTINGS_KEY,
        kind: opKind(rev), base_rev: rev, payload: { time_zone: zone },
        client_ts: new Date(now).toISOString(),
      },
      result: undefined,
    };
  }, now);
  return true;
}

/** What the drain's settings half may put on the wire, and how much it held back instead. */
export type SettingsSend = { op: OutboxOp | null; parked: number };

/**
 * The drain's settings half: SELECT the one generation that may go on the wire — the one already in
 * flight, else the oldest queued — and FREEZE it, in ONE readwrite transaction. The freeze moves the
 * intent snapshot onto the op (the immutable `{ op_id, base_rev, intents, generation }` record every
 * settlement reads back), names it in the meta as the generation in flight, and restarts the pending
 * intents empty, so an edit from here on is the NEXT generation with its own `op_id`.
 *
 * Selecting and freezing together is the whole point (T11b ninth-round P1). A selection read outside
 * this transaction — the drain's own `allOps` snapshot — is stale the moment a local edit replaces
 * the op it named: the coalescing writer retires that op and queues a successor, and freezing the
 * name afterwards would put the retired op back BESIDE the successor, whose answer then deletes the
 * newer edit. Here the op that is returned is the op in the row that was frozen.
 *
 * A settings op whose baseline was never confirmed is parked rather than sent (finding 2): it has no
 * rev to aim at and no row to diff its payload against, so `pullChanges` re-reads the feed for it.
 */
export async function selectAndFreezeSettings(h: AccountHandle, at: number): Promise<SettingsSend> {
  const db = await openAccountDb(h);
  const tx = db.transaction([META_STORE, OUTBOX_STORE], "readwrite");
  const meta = tx.objectStore(META_STORE);
  const outbox = tx.objectStore(OUTBOX_STORE);
  const stored = normalizeBaseline(await meta.get(BASELINE_KEY));
  const read = pendingSettingsOps((await outbox.getAll()) as OutboxOp[]);
  // Phase 9 §0.2: checked after the reads and before the first write of this transaction.
  assertCurrent(h);
  // Phase 18 W5b-2: an older build's frozen generation is upgraded (against the row it was frozen
  // on) and stored before anything else reads it.
  const { queued, held } = withFrozenIntents(stored, read);
  for (const op of queued) if (!read.includes(op)) await outbox.put(op);
  await holdIntents(meta, held);
  if (queued.length === 0) { await tx.done; return { op: null, parked: 0 }; }
  // `baseline` is the confirmed one: null drops into the park below, and anything else is a row the
  // server really holds, so the freeze has a rev to aim at and a row to diff intents against.
  const baseline = unconfirmedBaseline(stored) ? null : stored;
  if (baseline === null) {
    for (const op of queued) await outbox.put({ ...op, next_attempt_at: at + PARK_MS });
    console.warn(`sync: holding ${queued.length} user_settings op(s) until the server row is known`);
    await tx.done;
    return { op: null, parked: queued.length };
  }
  // The generation in flight is already frozen: its snapshot is on the op and the meta's intents
  // belong to the NEXT generation, so a retry has nothing to freeze and nothing to clear.
  const inFlightOp = baseline.sent === null ? null
    : queued.find((pending) => pending.op_id === baseline.sent) ?? null;
  if (inFlightOp !== null || baseline.sent !== null) {
    const selected = inFlightOp ?? queued[0];
    await tx.done;
    return { op: selected.next_attempt_at <= at ? selected : null, parked: 0 };
  }
  const sent = queued[0];
  if (sent.next_attempt_at > at) { await tx.done; return { op: null, parked: 0 }; }
  const generation = sent.generation ?? baseline.generation + 1;
  const frozen: OutboxOp = { ...sent, generation,
    intents: upgradeIntents(baseline.row, sent.intents ?? diffIntents(baseline.row, sent.payload)) };
  await outbox.put(frozen);
  await meta.put({ ...baseline, generation: Math.max(baseline.generation, generation),
    intents: [], sent: sent.op_id }, BASELINE_KEY);
  await tx.done;
  return { op: frozen, parked: 0 };
}

/**
 * A baseline this device has never confirmed against the server: none at all, or one whose row it
 * only ever built locally (`rev: null`). Either way there is no rev to aim an update at and no row
 * to diff a legacy payload against, so nothing may go on the wire — `pullChanges` re-reads the
 * change feed from the start for exactly this state.
 */
function unconfirmedBaseline(stored: SettingsBaseline | null): boolean {
  return stored === null || stored.rev === null;
}

/** The settings ops a drain or a pull must HOLD BACK (rule 3): a whole-row payload that was built
 *  against a row this device never recorded — a `create` and an `update` alike. A phone that
 *  upgrades with one used to send it straight to a server that already holds the row, and the
 *  server's own row answered it: the queued payload was dropped without a trace. */
export async function settingsAwaitingBaseline(
  h: AccountHandle, ops: readonly OutboxOp[],
): Promise<boolean> {
  const queued = pendingSettingsOps(ops);
  if (queued.length === 0) return false;
  return unconfirmedBaseline(await readSettingsBaseline(h));
}

/**
 * The pending generation's op for the state a settlement just installed: the one already queued for
 * it if there is one, else the settled op rewritten in place (a conflict re-aims the generation it
 * carried), else nothing when there is nothing left to carry.
 */
async function writeCarrier(h: AccountHandle, tx: SettlementTx, state: SettingsBaseline,
    settled: SettingsOp | null,
    waiting: readonly SettingsOp[], frozen: SettingsOp | null, generation: number,
    now: number): Promise<void> {
  const meta = tx.objectStore(META_STORE);
  const outbox = tx.objectStore(OUTBOX_STORE);
  const baseRev = pendingRev(state, frozen);
  // A baseline that still carries an intent must always have an op carrying it. Reaching the fresh
  // branch means the queue lost one, so this settlement puts it back instead of dropping the edit.
  const fresh = async (): Promise<SettingsOp> => {
    const seq = (((await meta.get(OUTBOX_SEQ_KEY)) as number | undefined) ?? 0) + 1;
    await meta.put(seq, OUTBOX_SEQ_KEY);
    return outboxRow(h, { op_id: crypto.randomUUID(), entity: ENTITY, entity_id: USER_SETTINGS_KEY,
      kind: opKind(baseRev), base_rev: baseRev, payload: {},
      client_ts: new Date(now).toISOString() }, seq, now);
  };
  const carrier = waiting[0] ?? settled ?? await fresh();
  const op: SyncOp & SettingsGeneration = { op_id: carrier.op_id, entity: ENTITY,
    entity_id: USER_SETTINGS_KEY, kind: opKind(baseRev), base_rev: baseRev,
    payload: payloadOf(state.row, frozen?.intents ?? [], state.intents),
    client_ts: carrier.client_ts, intents: state.intents, generation };
  await outbox.put(outboxRow(h, op, carrier.seq, now));
}

/**
 * The ONE settlement path for a settings op (`op`) or for a pull (`op === null`). One readwrite
 * transaction over [user_settings, outbox, meta]: the baseline moves, the pending generation is
 * rewritten onto it, and the mirror is rebuilt from the two. An answer for a generation that is no
 * longer in flight settles nothing at all — that is what keeps one op's `duplicate` from touching the
 * edit recorded since.
 */
export async function settleUserSettings(
  h: AccountHandle, op: OutboxOp | null, settlement: SettingsSettlement, now: number = Date.now(),
): Promise<void> {
  const db = await openAccountDb(h);
  const tx = db.transaction([ENTITY, OUTBOX_STORE, META_STORE], "readwrite");
  const meta = tx.objectStore(META_STORE);
  const outbox = tx.objectStore(OUTBOX_STORE);
  const stored = normalizeBaseline(await meta.get(BASELINE_KEY));
  const read = pendingSettingsOps((await outbox.getAll()) as OutboxOp[]);
  assertCurrent(h);
  // Phase 18 W5b-2: upgrade an older build's frozen generation against the row it was frozen on and
  // store it BEFORE this settlement (a pull included) moves the baseline off that row.
  const { queued, held } = withFrozenIntents(stored, read);
  for (const pending of queued) if (!read.includes(pending)) await outbox.put(pending);
  await holdIntents(meta, held);
  const settled = settledGeneration(stored, op, queued);
  // An answer for a generation that is no longer in flight (a repeated response, or a second push
  // racing the first) has nothing left to settle.
  if (op !== null && settled === null) { await tx.done; return; }
  const state = nextState(stored, settled, settlement, queued);
  if (stored === null && settled === null && state.rev === null && state.intents.length === 0) {
    // Nothing here can tell the server's row from this device's, so keep the mirror: deleting the
    // only copy of a recorded intent is worse than leaving a dropped op's value in it.
    await tx.done;
    return;
  }
  if (settled) await outbox.delete(settled.op_id);
  // The generation in flight is frozen; every other queued op was built for this settlement to
  // replace, and the pending generation rides whichever of them is left.
  const frozen = inFlight(state, queued);
  const waiting = queued.filter((pending) => pending !== settled && pending !== frozen);
  for (const pending of waiting) await outbox.delete(pending.op_id);
  const generation = Math.max(stored?.generation ?? 0, settled?.generation ?? 0) + 1;
  if (state.intents.length > 0) {
    await writeCarrier(h, tx, state, settled, waiting, frozen, generation, now);
  }
  await meta.put({ ...state, generation }, BASELINE_KEY);
  await tx.objectStore(ENTITY).put(settingsMirror(state, frozen), USER_SETTINGS_KEY);
  await tx.done;
}

/** A pull's write of the settings row: the server's row becomes the baseline, never the mirror. */
export function applyPulledUserSettings(
  h: AccountHandle, row: SettingsRow, rev: number,
): Promise<void> {
  return settleUserSettings(h, null, { status: "pull", row, rev });
}

/**
 * A pulled delete of the row (the server cannot actually delete it) clears every half: the mirror,
 * the baseline and the pending op that describes it — an op left behind would rebuild the mirror
 * from a baseline a later settlement can no longer find.
 */
export async function clearPulledUserSettings(h: AccountHandle): Promise<void> {
  const db = await openAccountDb(h);
  assertCurrent(h);
  const tx = db.transaction([ENTITY, OUTBOX_STORE, META_STORE], "readwrite");
  await tx.objectStore(ENTITY).delete(USER_SETTINGS_KEY);
  await tx.objectStore(META_STORE).delete(BASELINE_KEY);
  const ops = (await tx.objectStore(OUTBOX_STORE).getAll()) as OutboxOp[];
  for (const op of pendingSettingsOps(ops)) await tx.objectStore(OUTBOX_STORE).delete(op.op_id);
  await tx.done;
}

/**
 * The other half of the baseline-less recovery (ninth-round P1, finding 2). `pullChanges` re-read
 * the change feed from the start for a parked settings op and the feed carries no `user_settings`
 * row at all: the server holds none, so the queued payload IS the row to create. This installs the
 * explicit empty baseline (rev 0, no columns, every column of the payload an intent) and rewrites
 * the op as a `create` against it — a whole-row `update` aimed at a rev that never existed would be
 * answered `gone` and stay parked forever, because nothing else would release it.
 *
 * Returns false when there is nothing to establish (no queued op, or a baseline that was confirmed
 * against the server after all).
 */
export async function establishEmptySettingsBaseline(
  h: AccountHandle, now: number = Date.now(),
): Promise<boolean> {
  const db = await openAccountDb(h);
  const tx = db.transaction([ENTITY, OUTBOX_STORE, META_STORE], "readwrite");
  const meta = tx.objectStore(META_STORE);
  const outbox = tx.objectStore(OUTBOX_STORE);
  const stored = normalizeBaseline(await meta.get(BASELINE_KEY));
  const queued = pendingSettingsOps((await outbox.getAll()) as OutboxOp[]);
  assertCurrent(h);
  if (queued.length === 0 || !unconfirmedBaseline(stored)) { await tx.done; return false; }
  const generation = (stored?.generation ?? 0) + 1;
  const state: SettingsBaseline = { row: {}, rev: 0, generation, sent: null,
    intents: looseRecovery({}, queued) };
  const baseRev = pendingRev(state, null);
  const carrier = queued[0];
  const op: SyncOp & SettingsGeneration = { op_id: carrier.op_id, entity: ENTITY,
    entity_id: USER_SETTINGS_KEY, kind: opKind(baseRev), base_rev: baseRev,
    payload: payloadOf(state.row, [], state.intents), client_ts: carrier.client_ts,
    intents: state.intents, generation };
  for (const stale of queued.slice(1)) await outbox.delete(stale.op_id);
  await outbox.put(outboxRow(h, op, carrier.seq, now));
  await meta.put(state, BASELINE_KEY);
  await tx.objectStore(ENTITY).put(settingsMirror(state, null), USER_SETTINGS_KEY);
  await tx.done;
  return true;
}
