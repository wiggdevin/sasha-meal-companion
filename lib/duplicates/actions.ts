/**
 * Keep both / Merge for an open duplicate group, as durable sync ops (architecture §3.7).
 *
 * A decision is an ordinary `duplicate_groups` update through the outbox: `apply_sync_op` CAS-checks
 * it at `base_rev` and `_sync_upsert` writes it on the `(user_id, fingerprint)` arbiter, which is
 * why the payload carries the whole row (date, hex fingerprint, slot) and not only the new state.
 * The mirror row and the op commit in one IndexedDB transaction (`mutateRowWithOp`), so the card
 * goes the moment the decision is made and a pull cannot interleave between the read and the write.
 *
 * - **Keep both** → `state: "dismissed"`. Undo queues `state: "open"` aimed at the revision the
 *   queued ops will leave, so the two land in order.
 * - **Merge** → the other entries go through the normal delete path (`forgetLoggedEntry`: card,
 *   queued write, mirror row, then the server delete at its confirmed revision), then the group is
 *   `merged` with `merged_into_entry_id` = the oldest entry, whose items are left untouched. A
 *   delete is a durable tombstone on the server (`apply_sync_op` has no un-delete for an entry the
 *   user removed, and the app's own undo re-logs a NEW entry), so Merge offers no Undo.
 *
 * Every write takes the `AccountHandle` it was started under; after an account switch it throws
 * `AccountChanged` and writes nothing to either account.
 */
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import { forgetLoggedEntry } from "@/lib/log/delete-entry";
import { getRow, mutateRowWithOp, type OutboxOp, type RowWrite } from "@/lib/sync/idb";
import { announceQueued } from "@/lib/sync/outbox";
import type { SyncOp } from "@/lib/sync/types";
import { parseGroupRow, type DuplicateGroupRow, type OpenDuplicateGroup } from "./read";

export type DecisionOutcome = "queued" | "already_decided" | "missing";

type Decision =
  | { state: "dismissed" }
  | { state: "merged"; survivorId: string }
  | { state: "open" };

class NotWritten extends Error {
  constructor(readonly outcome: Exclude<DecisionOutcome, "queued">) { super(outcome); }
}

/** Queued `duplicate_groups` ops for this group: each will move the server's rev by one. */
function pendingFor(ops: readonly OutboxOp[], groupId: string): number {
  return ops.filter((op) => op.entity === "duplicate_groups" && op.entity_id === groupId).length;
}

function payloadFor(group: DuplicateGroupRow, decision: Decision, nowIso: string): Record<string, unknown> {
  return {
    id: group.id, local_date: group.localDate, fingerprint: group.fingerprint, slot: group.slot,
    state: decision.state,
    merged_into_entry_id: decision.state === "merged" ? decision.survivorId : null,
    decided_at: decision.state === "open" ? null : nowIso,
  };
}

/**
 * One decision, written only from the state it expects (`from`): a second tap, another tab or a
 * pulled decision finds the row already moved and writes nothing.
 */
async function writeDecision(
  h: AccountHandle, groupId: string, from: DuplicateGroupRow["state"], decision: Decision,
  now: number,
): Promise<DecisionOutcome> {
  const nowIso = new Date(now).toISOString();
  try {
    await mutateRowWithOp(h, "duplicate_groups", groupId,
      (current, reads): RowWrite<null> => {
        const group = current ? parseGroupRow(current) : null;
        if (!group) throw new NotWritten("missing");
        if (group.state !== from) throw new NotWritten("already_decided");
        const payload = payloadFor(group, decision, nowIso);
        const op: SyncOp = {
          op_id: crypto.randomUUID(), entity: "duplicate_groups", entity_id: groupId,
          kind: "update", base_rev: group.rev + pendingFor(reads.ops, groupId), payload,
          client_ts: nowIso,
        };
        // The mirror keeps the server's rev: only an applied answer or a pull moves it.
        return { row: { ...current, ...payload }, op, result: null };
      }, now);
  } catch (error) {
    if (error instanceof NotWritten) return error.outcome;
    throw error;
  }
  announceQueued();
  return "queued";
}

/** Keep both entries: the group is dismissed and both keep counting. */
export function keepBoth(h: AccountHandle, groupId: string, now: number = Date.now()): Promise<DecisionOutcome> {
  return writeDecision(h, groupId, "open", { state: "dismissed" }, now);
}

/** Undo a Keep both: the group opens again, so the card comes back. */
export function undoKeepBoth(h: AccountHandle, groupId: string, now: number = Date.now()): Promise<DecisionOutcome> {
  return writeDecision(h, groupId, "dismissed", { state: "open" }, now);
}

const merging = new Set<string>();

/**
 * Merge: keep the oldest entry as it is, delete the others through the normal delete path, then
 * record the group as merged into the survivor. A group that is no longer open is left alone, and a
 * merge already running for the same group is not started twice.
 */
export async function mergeGroup(
  h: AccountHandle, open: OpenDuplicateGroup, now: number = Date.now(),
): Promise<DecisionOutcome> {
  const { group, members } = open;
  if (members.length < 2) return "missing";
  const key = `${h.userId}:${group.id}`;
  if (merging.has(key)) return "already_decided";
  merging.add(key);
  try {
    const mirror = parseGroupRow(((await getRow(h, "duplicate_groups", group.id)) ?? {}) as Record<string, unknown>);
    if (!mirror) return "missing";
    if (mirror.state !== "open") return "already_decided";
    assertCurrent(h);
    const [survivor, ...others] = members;
    // Deletes first: if this stops half way (an account switch), the day shows one entry and the
    // group, with a single live member, no longer draws a card.
    for (const other of others) await forgetLoggedEntry(group.localDate, other.entryId, h);
    return await writeDecision(h, group.id, "open", { state: "merged", survivorId: survivor.entryId }, now);
  } finally {
    merging.delete(key);
  }
}
