/**
 * What the drain does about a `log_entries` op, which is not what it does about any other entity:
 * the commit path owns these entries, and the drain has to stand out of its way.
 *
 * Split out of lib/sync/outbox.ts, which was already past 400 lines before T0 touched it; no
 * behaviour moved with it.
 */
import type { AccountHandle } from "@/lib/device/account";
import { allOps, deleteOp, deleteRow, putOp, type OutboxOp } from "./idb";
import { queuedAfter, replaceQueued, retryStaleRead } from "./row-queue";
import { backoffMs } from "./backoff";
import { PARK_MS } from "./settings";
import { joinNotes, mergeNoteFromBase } from "./merge";
import { isCompleteEntryRow, serverFields } from "@/lib/log/entry-row";
import type { OpResult } from "./types";
import { confirmEntry, isDeleted } from "@/lib/log/pending";
import { finishDelete } from "@/lib/log/delete-entry";
import { isCommitting } from "@/lib/log/live-commits";
import { reconcileFromServer } from "@/lib/log/reconcile";

/**
 * The due ops this drain may actually send.
 *
 * A log entry whose commit is POSTING RIGHT NOW is not one of them. Its op is queued before the
 * POST and `enqueue` wakes the sync, so a drain can land while /api/log/commit is still open — and
 * then two paths settle one entry: the drain reads the row back and clears the record while the
 * POST is in the air, and a 4xx on that POST rolls back the row the drain has just confirmed.
 *
 * "Right now" means in this tab or any other tab of the app, which is why the question goes to the
 * live-commit lock and not to the durable record. The record says `in_flight` after a kill too, and standing off THAT waits
 * on a request that no longer exists anywhere: the write the user made a second before the app died
 * would sit in the outbox unsent (panel round 15). A killed-mid-post entry therefore drains on the
 * next launch, and if the POST had in fact landed the server answers `duplicate` and the reconcile
 * settles it.
 */
export async function drainable(due: OutboxOp[]): Promise<OutboxOp[]> {
  const out: OutboxOp[] = [];
  for (const op of due) {
    if (op.entity === "log_entries" && await isCommitting(op.entity_id)) continue;
    out.push(op);
  }
  return out;
}

/**
 * An entry the server has: settle it from the server, then drop the op.
 *
 * Never `{...local, ...payload, rev}` — that is the REQUEST's items under the server's revision, a
 * row the server never held (Grok pass 3, MEDIUM 3). The commit path may already have settled this
 * entry, and this must not undo that; an entry that could not be read back keeps its pending
 * record, and the catch-up reads it again.
 */
export async function settleLogEntry(h: AccountHandle, op: OutboxOp): Promise<void> {
  // `applied` and `duplicate` both mean the server has it, whatever the read-back then finds.
  await confirmEntry(h, op.entity_id);
  await deleteOp(h, op.op_id);
  // The user deleted it meanwhile: the server has the entry, so what is owed is the delete, not a row
  // to mirror (Grok pass 12, HIGH 1).
  if (await isDeleted(h, op.entity_id)) {
    await finishDelete(h, op.entity_id);
    return;
  }
  await reconcileFromServer(h, op.entity_id);
}

/**
 * A delete the server refused because it had moved on.
 *
 * Merging it like any other conflict put the entry back: the server's row went into the mirror,
 * and the op was re-queued carrying that row. Their delete does not become the meal again — it is
 * simply re-aimed at the revision the server now holds (Grok pass 12, HIGH 2).
 */
export async function rebaseLogDelete(
  h: AccountHandle, op: OutboxOp, currentRev: unknown, now: () => number = Date.now,
): Promise<void> {
  await deleteRow(h, "log_entries", op.entity_id).catch(() => undefined);
  // It is the SAME op, re-aimed: keeping the row keeps what it has already cost, so a row another
  // device keeps changing cannot make this a tight conflict-rebase-drain loop, and an answer with
  // no revision to aim at parks it rather than retrying for ever (Grok pass 13, MEDIUM 4).
  const attempts = (op.error_attempts ?? 0) + 1;
  const parked = attempts >= MAX_DELETE_REBASES || typeof currentRev !== "number";
  if (parked) {
    console.warn(`sync: delete for ${op.entity_id} parked after ${attempts} refusals.`);
  }
  await putOp(h, {
    ...op,
    base_rev: typeof currentRev === "number" ? currentRev : op.base_rev,
    error_attempts: attempts,
    next_attempt_at: now() + (parked ? PARK_MS : backoffMs(attempts)),
  });
}

/** Refusals before a delete is parked rather than re-aimed — the outbox's own error ceiling. */
const MAX_DELETE_REBASES = 3;

/** The same ceiling for their note: re-aimed a few times, then parked rather than sent for ever. */
export const MAX_UPDATE_REBASES = 3;

/**
 * A note the server refused because the entry has moved on.
 *
 * The only update this app queues is the note the user typed on a card, and its payload is a whole row
 * — the row as this phone knew it. Settling it like a create deleted it: the line the user wrote never
 * reached the server, and the read-back then wrote the server's empty note over theirs (Grok pass
 * 28, HIGH 1). Rebasing the whole payload is just as wrong, because the phone's items would go
 * over the ones the other device has just changed.
 *
 * So the op is re-aimed: the server's row, with THEIR note on it. The mirror takes the server's row
 * too, and the card keeps their note until this op lands, because `ownWriteQueued` still sees it.
 *
 * The note edits queued right behind it fold into the same rebase (audit 2026-10-10 W011 review):
 * the latest one is what the user means now, and the first one's base is the note the run of
 * edits started from. Rebased one at a time, a replaced rewrite came back — the first rebase joined
 * it to the other device's note, and the next edit's base no longer matched that join.
 */
export function rebaseLogNote(
  h: AccountHandle, op: OutboxOp, result: Extract<OpResult, { status: "conflict" }>, now: () => number = Date.now,
): Promise<void> {
  // An edit queued while this works the rebase out makes the write refuse; it is worked out again.
  return retryStaleRead(() => rebaseLogNoteOnce(h, op, result, now));
}

async function rebaseLogNoteOnce(
  h: AccountHandle, op: OutboxOp, result: Extract<OpResult, { status: "conflict" }>, now: () => number,
): Promise<void> {
  const server = (result.current ?? {}) as Record<string, unknown>;
  const seen = queuedAfter(await allOps(h), op);
  const folded = noteEditsAfter(seen);
  const latest = folded.length > 0 ? folded[folded.length - 1] : op;
  const mine = latest.payload as Record<string, unknown>;
  const serverTs = String(server.updated_at ?? "");
  // With the note the edits started from, only a note BOTH sides changed is joined: one the other
  // device left alone takes the user's, a clear included (audit 2026-10-10 A077). An op queued before
  // that base was recorded keeps the old rule. Theirs second: it is the newer of the two, and a
  // note is evidence — neither side's is dropped.
  const note = op.note_base === undefined
    ? joinNotes(server.note, mine.note, serverTs, latest.client_ts)
    : mergeNoteFromBase(op.note_base, mine.note, server.note, latest.client_ts, serverTs);
  // The re-aimed payload is built on the server's row, so the server's note is its base now.
  const serverNote = typeof server.note === "string" ? server.note.trim() : "";
  const attempts = (op.error_attempts ?? 0) + 1;
  const parked = attempts >= MAX_UPDATE_REBASES || typeof result.current_rev !== "number";
  if (parked) console.warn(`sync: note for ${op.entity_id} parked after ${attempts} refusals.`);
  // One transaction: the folded edits leave, the re-aimed op keeps this op's place in the queue,
  // and the mirror takes the server's row when it is a whole one.
  await replaceQueued(h, op, {
    ...op,
    base_rev: typeof result.current_rev === "number" ? result.current_rev : op.base_rev,
    payload: { ...serverFields(server), id: op.entity_id, note: note ?? null },
    client_ts: latest.client_ts,
    note_base: serverNote || null,
    error_attempts: attempts,
    next_attempt_at: now() + (parked ? PARK_MS : backoffMs(attempts)),
  }, folded.map((o) => o.op_id), isCompleteEntryRow(server) ? server : null, seen);
}

/** The run of note edits at the head of `behind` (the ops queued after a refused one). */
function noteEditsAfter(behind: readonly OutboxOp[]): OutboxOp[] {
  const out: OutboxOp[] = [];
  for (const next of behind) {
    if (next.kind !== "update") break;
    out.push(next);
  }
  return out;
}

/**
 * Everything the drain does about a `log_entries` op, in one place: its answers are not the
 * generic ones. `applied` and `duplicate` both mean the server has the entry; a refused DELETE is
 * re-aimed rather than merged. Returns false for an answer with no log-entry rule of its own.
 *
 * A refused CREATE or UPDATE is settled from the server, like any other proof that the entry is
 * there. Every commit queues before it posts, so this is an ordinary path, and the generic rule
 * for it merged `{...mirror, ...payload}` at the server's revision — this phone's items under a
 * revision the server has moved past, which is the one row the commit path exists to refuse. Them
 * next note based on it, the server refused that too, and the rollback took a meal the server
 * holds off Today (Grok pass 25, HIGH 1).
 */
export async function handleLogEntryResult(
  h: AccountHandle, result: OpResult, op: OutboxOp,
): Promise<boolean> {
  if (result.status === "applied" || result.status === "duplicate") {
    await settleLogEntry(h, op);
    return true;
  }
  if (result.status !== "conflict") return false;
  if (op.kind === "delete") {
    await rebaseLogDelete(h, op, result.current_rev);
    return true;
  }
  // An update is their note, and it is re-aimed rather than settled: settling it would drop the
  // line the user wrote (Grok pass 28, HIGH 1). A create has nothing of theirs the server lacks.
  if (op.kind === "update") {
    await rebaseLogNote(h, op, result);
    return true;
  }
  await settleLogEntry(h, op);
  return true;
}
