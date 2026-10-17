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
 *   user removed), so an exact Undo cannot come after it. `scheduleMerge` therefore holds the merge
 *   for `MERGE_UNDO_MS`, past the life of the Undo toast, and writes nothing until it runs: Undo inside
 *   that window leaves both entries and the group exactly as they were (OD16). Leaving the page
 *   runs a held merge at once; a page killed outright drops it, and the card comes back.
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

/** A second past the Undo toast (`NOTICE_MS`, 5 s, in components/ui/ActionFeedback.tsx), whose
 *  clock starts only after the hold does: Undo is never shown for a merge already running. */
export const MERGE_UNDO_MS = 6_000;
/** Fired whenever a held merge starts, is undone or runs, so the card re-reads. */
export const MERGE_PENDING_EVENT = "duplicates:merge-pending";

type HeldMerge = { h: AccountHandle; open: OpenDuplicateGroup; timer: ReturnType<typeof setTimeout> };
const held = new Map<string, HeldMerge>();
let flushOnLeave = false;

const heldKey = (h: AccountHandle, groupId: string) => `${h.userId}:${groupId}`;
const announceHeld = () => globalThis.dispatchEvent?.(new Event(MERGE_PENDING_EVENT));

/** True while a merge of this group waits out its Undo window on this page. */
export function isMergeHeld(h: AccountHandle, groupId: string): boolean {
  return held.has(heldKey(h, groupId));
}

async function runHeld(key: string): Promise<DecisionOutcome | null> {
  const entry = held.get(key);
  if (!entry) return null;
  clearTimeout(entry.timer);
  held.delete(key);
  try {
    return await mergeGroup(entry.h, entry.open);
  } catch (error) {
    // An account switch or a failed write leaves the group open, so its card comes back.
    console.warn("duplicate merge did not run", error);
    return null;
  } finally {
    announceHeld();
  }
}

/** Run every held merge now (the page is going away). */
export async function flushHeldMerges(): Promise<void> {
  await Promise.all([...held.keys()].map((key) => runHeld(key)));
}

/**
 * Merge with an exact Undo: nothing is written for `delayMs`, then `mergeGroup` runs. `undo()`
 * inside the window cancels it and answers true; once the merge has started it answers false.
 */
export function scheduleMerge(
  h: AccountHandle, open: OpenDuplicateGroup, delayMs: number = MERGE_UNDO_MS,
): { undo: () => boolean } {
  assertCurrent(h);
  const key = heldKey(h, open.group.id);
  if (!held.has(key)) {
    const timer = setTimeout(() => { void runHeld(key); }, delayMs);
    held.set(key, { h, open, timer });
    if (!flushOnLeave) {
      flushOnLeave = true;
      globalThis.addEventListener?.("pagehide", () => { void flushHeldMerges(); });
    }
    announceHeld();
  }
  return {
    undo: () => {
      const entry = held.get(key);
      if (!entry) return false;
      clearTimeout(entry.timer);
      held.delete(key);
      announceHeld();
      return true;
    },
  };
}

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
