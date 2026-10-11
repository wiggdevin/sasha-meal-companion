/**
 * What the drain does about a `conflict` answer — architecture §3.7's rebase. Split out of
 * lib/sync/outbox.ts (held at its size by tests/speed/file-size.test.ts); the drain still owns
 * the queue, so this settles the mirror and the refused op and hands back the op to queue next.
 */
import { deleteOp, getRow, putRow, wireOp, type AccountHandle, type OutboxOp } from "./idb";
import { mergeEntity, NEVER_MERGED, rebaseOp, type Row } from "./merge";
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

/**
 * Settle a refused op: the mirror takes the merged row and the op leaves the queue. Returns the
 * rebased op the caller queues in its place, or null when nothing is left to send.
 */
export async function settleConflict(
  h: AccountHandle, result: Extract<OpResult, { status: "conflict" }>, op: OutboxOp, now: () => number,
): Promise<SyncOp | null> {
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
    await putRow(h, op.entity, op.entity_id, { ...server, deleted_at: null, rev: result.current_rev });
    await deleteOp(h, op.op_id);
    return restarAsRestore(op, result.current_rev, now());
  }
  // syncOnce pulls before it pushes, so the mirror already holds the server's row by now. The op's
  // payload is the only surviving record of what the user meant, so it wins over the mirror.
  const mirror = ((await getRow(h, op.entity, op.entity_id)) ?? {}) as Row;
  const local = { ...mirror, ...op.payload } as Row;
  const merged = mergeEntity(op.entity, local, server, op.client_ts,
    serverTimestampOf(server, new Date(now()).toISOString()));
  const rebased = rebaseOp(wireOp(op), stripServerOwned(merged), result.current_rev);
  await putRow(h, op.entity, op.entity_id, { ...merged, rev: result.current_rev });
  await deleteOp(h, op.op_id);
  return rebased;
}
