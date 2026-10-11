/**
 * What the drain does about a `conflict` answer — architecture §3.7's rebase. Split out of
 * lib/sync/outbox.ts (held at its size by tests/speed/file-size.test.ts); the drain still owns
 * the queue, so this works out the rebase and hands it back for the drain to commit.
 */
import {
  allOps, deleteOp, getRow, putRow, wireOp, type AccountHandle, type OutboxOp,
} from "./idb";
import { mergeEntity, NEVER_MERGED, rebaseOp, type Row } from "./merge";
import { queuedAfter } from "./row-queue";
import { settleUserSettings } from "./settings";
import type { OpResult, SyncOp } from "./types";

export const TARGETS_CHANGED_EVENT = "meal-companion:targets-changed";

/** A conflict carries the row but no stamp of its own, and the synced tables use three different
 *  names for "when". Falling back to now lets the server win a tie, which is right: its row was
 *  written after our `base_rev`. See Open question 1. */
export function serverTimestampOf(row: unknown, fallback: string): string {
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
export type Rebase = { op: SyncOp; retire: string[]; mirror: Row };

/**
 * The run of create/update ops queued right behind `op` for its row. They were aimed at revisions
 * only `op` could produce; folded into its rebase, the latest of them is what the rebase carries
 * (audit 2026-10-10 A165, A141), instead of a rebased older edit landing after them.
 */
function foldable(all: readonly OutboxOp[], op: OutboxOp): OutboxOp[] {
  if (op.kind !== "create" && op.kind !== "update") return [];
  const out: OutboxOp[] = [];
  for (const next of queuedAfter(all, op)) {
    if (next.kind !== "create" && next.kind !== "update") break;
    out.push(next);
  }
  return out;
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
  if (op.kind === "create" && FAVORITES.has(op.entity) && server.deleted_at) {
    // A restore keeps the server row's own columns (its sort), so that is what the mirror shows.
    return { op: restarAsRestore(op, result.current_rev, now()), retire: [],
      mirror: { ...server, deleted_at: null, rev: result.current_rev } };
  }
  // syncOnce pulls before it pushes, but a pulled row is held while an op for it is queued, so the
  // mirror holds the newest optimistic state. The ops' payloads are the only surviving record of
  // what the user meant, oldest first, so they win over the mirror.
  const folded = foldable(await allOps(h), op);
  const mirror = ((await getRow(h, op.entity, op.entity_id)) ?? {}) as Row;
  const local = Object.assign({ ...mirror }, op.payload, ...folded.map((o) => o.payload)) as Row;
  const localTs = folded.length > 0 ? folded[folded.length - 1].client_ts : op.client_ts;
  const merged = mergeEntity(op.entity, local, server, localTs,
    serverTimestampOf(server, new Date(now()).toISOString()));
  return {
    op: rebaseOp(wireOp(op), stripServerOwned(merged), result.current_rev),
    retire: folded.map((o) => o.op_id),
    mirror: { ...merged, rev: result.current_rev },
  };
}
