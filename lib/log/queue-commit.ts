/**
 * The offline half of a commit: the outbox write it makes before it posts, and what the commit
 * does with a failure the server never answered.
 *
 * Its own module so lib/log-commit-client.ts stays under 400 lines. Nothing moved with it.
 */
import { rethrowAccountChanged, type AccountHandle } from "@/lib/device/account";
import type { LogCommitRequest } from "@/lib/log/contract";
import { isDeleted, settleDeletedEntry } from "@/lib/log/delete-entry";
import { opIdFor } from "@/lib/log/op-id";
import { clearPending } from "@/lib/log/pending";
import { hasQueuedOp, type OptimisticWrite } from "@/lib/log-commit-settle";
import { enqueue } from "@/lib/sync/outbox";

/**
 * queue(h)'s own IndexedDB write can reject (a blocked/failed DB open). `return queue(h, req)` alone
 * does not hand that rejection to either caller's surrounding catch — the async function has
 * already returned by the time it settles — so it must be caught here and turned into a status the
 * caller can see, instead of an unhandled rejection out of commitLogEntry.
 */
/**
 * A transient failure. The op is already in the outbox — `writeLocalFirst` put it there before
 * the POST — so this confirms it is still there rather than writing a second one, and hands the
 * pending mark over to it. The mirror row stays: it is the payload that op will apply.
 */
export async function safeQueue(
  h: AccountHandle,
  req: LogCommitRequest, optimistic?: OptimisticWrite
): Promise<{ status: "queued" } | { status: "unqueued" } | { status: "discarded" }> {
  // A retryable answer normally hands the entry to the outbox. Not one the user has deleted: writing
  // the create back would have the drain build the meal the user just removed (Grok pass 12, HIGH 1).
  if (await isDeleted(h, req.entry_id)) {
    await settleDeletedEntry(h, req.entry_id, optimistic?.date);
    // `queued` would be a lie with a card behind it: the sheet closes as if the meal were on its
    // way and adds it back (Grok pass 15, HIGH 1).
    return { status: "discarded" };
  }
  try {
    const queued = await queue(h, req);
    // The outbox owns the pending mark from here on; Today re-reads it on the same event.
    await clearPending(h, req.entry_id);
    return queued;
  } catch (e) {
    rethrowAccountChanged(e);
    // The POST has already gone out: the server may hold the entry, and the op written before it
    // is still in the outbox — `enqueue` replaces by op id, so this failure removed nothing.
    // Taking the card back here told them to log a meal that was on its way, and the drain sent
    // the first op while the user logged the second: two meals (Grok pass 16, HIGH 1). So nothing
    // local is undone, and the record stays `in_flight` for `promoteOrphans` to settle.
    console.warn("Could not confirm the queued entry after posting; the catch-up will settle it.");
    // `true`, and nothing else: an outbox nobody can read cannot promise a drain will send it.
    return await hasQueuedOp(h, req.entry_id) === true
      ? { status: "queued" } : { status: "unqueued" };
  }
}

/**
 * The offline path of contracts §4: the same payload as a `log_entries` op, applied later by
 * /api/sync/ops, which calls compute_item_snapshot in SQL. Both paths reach applyLogEntry.
 *
 * `encodeKey("log_entries", …)` (lib/sync/keys.ts) reads the row's `id`, not `entry_id` — the
 * outbox's key convention predates this contract's field name. `enqueue`'s
 * `assertKeyMatchesPayload` guard throws if the two disagree, so the payload carries both.
 */
export async function queue(h: AccountHandle, req: LogCommitRequest): Promise<{ status: "queued" }> {
  await enqueue(h, {
    // The SAME id the server derives for this commit (lib/server/log.ts's opFor), so two failed
    // attempts at one entry are one op rather than two replays of the same write.
    op_id: opIdFor(req.entry_id, req.base_rev),
    entity: "log_entries",
    entity_id: req.entry_id,
    kind: req.base_rev === undefined ? "create" : "update",
    base_rev: req.base_rev ?? null,
    payload: { ...req, id: req.entry_id } as unknown as Record<string, unknown>,
    client_ts: new Date().toISOString(),
  });
  return { status: "queued" };
}

