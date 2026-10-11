/**
 * What the drain does about a `conflict` answer — architecture §3.7's rebase. Split out of
 * lib/sync/outbox.ts (held at its size by tests/speed/file-size.test.ts); the drain still owns
 * the queue, so this works out the rebase and hands it back for the drain to commit.
 */
import {
  allOps, deleteOp, getRow, putRow, wireOp, type AccountHandle, type OutboxOp, type QueuedSyncOp,
} from "./idb";
import {
  carriedPlanDayStamps, mergeEntity, mergePlanDayFields, NEVER_MERGED, planDayStamps, rebaseOp,
  type Row,
} from "./merge";
import { hasStoredRole, isRoleDelta } from "./role-delta";
import { queuedAfter } from "./row-queue";
import { settleUserSettings } from "./settings";
import type { OpResult, SyncOp } from "./types";

export const TARGETS_CHANGED_EVENT = "meal-companion:targets-changed";

/** When the server's row was written. A conflict answer carries it as `at` (W026, migration
 *  20261231180000: the row's last change_log time, or its `updated_at` when later); an answer from
 *  a server that predates it carries only the row, whose tables use three different names for
 *  "when". Falling back to now lets the server win a tie, which is right: its row was written
 *  after our `base_rev`. */
export function serverTimestampOf(row: unknown, fallback: string, at?: unknown): string {
  if (typeof at === "string" && !Number.isNaN(Date.parse(at))) return at;
  const r = (row ?? {}) as Record<string, unknown>;
  for (const column of ["updated_at", "changed_at", "eaten_at", "created_at"]) {
    const value = r[column];
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  }
  return fallback;
}

/** Columns the server owns: sending them back to apply_sync_op would ask it to overwrite its own
 *  bookkeeping. `base_rev` carries the rev the rebased op is aimed at. */
const SERVER_OWNED = ["user_id", "rev", "seq", "created_at", "updated_at"] as const;

function stripServerOwned(row: Row): Row {
  const out: Row = { ...row };
  for (const column of SERVER_OWNED) delete out[column];
  return out;
}

/** The one settings entity — the row lib/sync/settings.ts owns the baseline and mirror of. */
const SETTINGS = "user_settings";

/** Favorites are keyed by what was starred, so starring it again names the server's own row. */
const FAVORITES: ReadonlySet<string> = new Set(["favorites_foods", "favorites_recipes", "favorites_meals"]);

/**
 * A star on a favorite the server holds as a tombstone (audit 2026-10-10 A078). An unstar that
 * synced leaves the server row tombstoned, and the pull of that delete drops the local row, so the
 * next star is a `create` the server refuses. Merged like any conflict, the tombstone dominated, the
 * rebased `update` answered `deleted` and the star was thrown away. Starring again IS a restore of
 * that row: the op is re-aimed as one at the server's revision, and the mirror shows it starred.
 */
function restarAsRestore(op: OutboxOp, currentRev: number, now: number): SyncOp {
  return {
    op_id: crypto.randomUUID(), entity: op.entity, entity_id: op.entity_id, kind: "restore",
    base_rev: currentRev, payload: {}, client_ts: new Date(now).toISOString(),
  };
}

/** A refused op's replacement: the rebase, the queued ops folded into it, and the mirror row. */
export type Rebase = { op: QueuedSyncOp; retire: string[]; mirror: Row; seen: OutboxOp[] };

/**
 * The run of create/update ops at the head of `behind`, the ops queued right behind `op` for its
 * row. They were aimed at revisions only `op` could produce; folded into its rebase, the latest of
 * them is what the rebase carries (audit 2026-10-10 A165, A141), instead of a rebased older edit
 * landing after them.
 */
function foldable(behind: readonly OutboxOp[], op: OutboxOp): OutboxOp[] {
  if (op.kind !== "create" && op.kind !== "update") return [];
  const out: OutboxOp[] = [];
  for (const next of behind) {
    if (next.kind !== "create" && next.kind !== "update") break;
    out.push(next);
  }
  return out;
}

/**
 * A refused `plan_days` edit and the edits queued behind it, merged field by field and slot by
 * slot onto the server's day (audit 2026-10-10 A141, backlog B091). The rebase carries only the
 * fields they wrote, each based on the server's value now. Null for an op queued before field-wise
 * edits existed (no `base_fields`): its whole-row payload takes the generic merge.
 */
function rebasePlanDay(
  behind: OutboxOp[], op: OutboxOp, server: Row, currentRev: number, serverTs: string,
): Rebase | null {
  const ops = [op, ...foldable(behind, op)];
  if (ops.some((o) => o.base_fields === undefined)) return null;
  const touched = Object.assign({}, ...ops.map((o) => o.payload)) as Row;
  const base: Row = {};
  for (const o of ops) {
    for (const [field, value] of Object.entries(o.base_fields!)) if (!(field in base)) base[field] = value;
  }
  // Each field and slot is "newer" by its own last edit, not by the run's last op (Sol WARN 4).
  const stamps = planDayStamps(ops);
  const merged = mergePlanDayFields(touched, base, server, stamps, serverTs);
  const fields = Object.keys(merged).filter((field) => field !== "local_date" && field !== "eaten_slots");
  return {
    op: { ...rebaseOp(wireOp(op), merged, currentRev),
      base_fields: Object.fromEntries(fields.map((field) => [field, server[field] ?? null])),
      field_stamps: carriedPlanDayStamps(merged, server, stamps) },
    retire: ops.slice(1).map((o) => o.op_id),
    mirror: { ...server, ...merged, rev: currentRev },
    seen: behind,
  };
}

/**
 * Settle a refused op. The never-merged and settings answers are written here; every other one is
 * returned as a `Rebase` for the caller to commit in one transaction (lib/sync/row-queue.ts), or
 * null when nothing is left to send.
 */
export async function settleConflict(
  h: AccountHandle, result: Extract<OpResult, { status: "conflict" }>, op: OutboxOp, now: () => number,
): Promise<Rebase | null> {
  const server = (result.current ?? {}) as Row;
  if (NEVER_MERGED.has(op.entity)) {
    await putRow(h, op.entity, op.entity_id, server);
    await deleteOp(h, op.op_id);
    globalThis.dispatchEvent?.(new Event(TARGETS_CHANGED_EVENT));
    return null;
  }
  if (op.entity === SETTINGS) {
    // A settings conflict is not a field merge: the server's row becomes the baseline, the intents
    // recorded since are replayed onto it and the SAME op is rewritten at the server's rev, all in
    // one transaction (lib/sync/settings.ts). A successor op would be aimed at a speculative rev.
    await settleUserSettings(h, op, { status: "conflict", row: server, rev: result.current_rev },
      now());
    return null;
  }
  // What is queued behind the refused op now; the requeue refuses if that changes before it lands.
  const seen = queuedAfter(await allOps(h), op);
  if (op.kind === "create" && FAVORITES.has(op.entity) && server.deleted_at) {
    // A restore keeps the server row's own columns (its sort), so that is what the mirror shows.
    return { op: restarAsRestore(op, result.current_rev, now()), retire: [], seen,
      mirror: { ...server, deleted_at: null, rev: result.current_rev } };
  }
  if (isRoleDelta(op)) {
    // A role delta stays a delta at the server's rev (P15); a role stored meanwhile wins.
    if (hasStoredRole(server)) {
      await putRow(h, op.entity, op.entity_id, { ...server, rev: result.current_rev });
      await deleteOp(h, op.op_id);
      return null;
    }
    return { op: rebaseOp(wireOp(op), { role: op.payload.role }, result.current_rev), retire: [], seen,
      mirror: { ...server, role: op.payload.role, rev: result.current_rev } };
  }
  const serverTs = serverTimestampOf(server, new Date(now()).toISOString(), result.at);
  if (op.entity === "plan_days") {
    const day = rebasePlanDay(seen, op, server, result.current_rev, serverTs);
    if (day) return day;
  }
  // syncOnce pulls before it pushes, but a pulled row is held while an op for it is queued, so the
  // mirror holds the newest optimistic state. The ops' payloads are the only surviving record of
  // what the user meant, oldest first, so they win over the mirror.
  const folded = foldable(seen, op);
  const mirror = ((await getRow(h, op.entity, op.entity_id)) ?? {}) as Row;
  const local = Object.assign({ ...mirror }, op.payload, ...folded.map((o) => o.payload)) as Row;
  const localTs = folded.length > 0 ? folded[folded.length - 1].client_ts : op.client_ts;
  const merged = mergeEntity(op.entity, local, server, localTs, serverTs);
  return {
    op: rebaseOp(wireOp(op), stripServerOwned(merged), result.current_rev),
    retire: folded.map((o) => o.op_id),
    mirror: { ...merged, rev: result.current_rev },
    seen,
  };
}
