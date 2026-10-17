/**
 * The local half of a commit (T0 §3): the record every card stands on, the queued write and the
 * mirror row, all written before the POST. Split out of lib/log-commit-client.ts when Phase 9's
 * account handle took it past 400 lines; no behaviour moved with it. Every step takes the handle
 * of the commit that started it, and an `AccountChanged` is never swallowed as a local failure.
 */
import { rethrowAccountChanged, type AccountHandle } from "@/lib/device/account";
import type { LogCommitRequest } from "@/lib/log/contract";
import { isCompleteEntryRow } from "@/lib/log/entry-row";
import { markDurable, markInFlight, retirePending } from "@/lib/log/pending";
import { queue } from "@/lib/log/queue-commit";
import { localRow, type MirrorBefore } from "@/lib/log-commit-settle";
import { getRow, putRow } from "@/lib/sync/idb";
import type { LoggedFood } from "@/lib/types";

/**
 * The record every card stands on, written BEFORE the card is painted.
 *
 * A card with no record is a meal the user can see while nothing on the phone is sending it and
 * nothing can send it again — no mark, no kept request, no "try again". A kill or a blocked
 * database in that gap is exactly the meal the user would not log a second time (Grok pass 21, HIGH 1).
 *
 * The revision it carries comes from the REQUEST, which is the only place that cannot lie about
 * it: the mirror read is best effort, and a blocked database answering nothing turned an edit
 * into "any complete row is mine" (Grok pass 9, HIGH 3). A create is based on nothing, which is
 * 0 — every real revision is past it.
 */
export async function recordFirst(
  h: AccountHandle,
  req: LogCommitRequest, automatic: boolean, card?: LoggedFood,
): Promise<void> {
  await markInFlight(h, req.entry_id, h.userId,
    // The card goes down WITH the request: the wire carries ids and grams, so a meal's name, them
    // note and every line the wire never carried live here or nowhere (Grok pass 23, HIGH 1).
    { request: req, baseRev: req.base_rev ?? 0, automatic, card });
}

/**
 * The rest of the local write, which happens for EVERY commit — T0 §3. The record is down and the
 * card is up by now; what this adds is the queued write and the mirror row, which are what make
 * the write local-first rather than a decoration on one screen.
 *
 * Returns whatever the mirror held before, so a refused commit can put it back.
 */
export async function writeLocalFirst(h: AccountHandle, req: LogCommitRequest): Promise<MirrorBefore> {
  // This attempt's identity, stamped on the row it writes so only it can take that row back.
  const attemptId = crypto.randomUUID();
  let before: MirrorBefore = { read: false, attemptId };
  try {
    before = { read: true, attemptId,
      previous: await getRow(h, "log_entries", req.entry_id) as Record<string, unknown> | undefined };
  } catch (e) {
    rethrowAccountChanged(e);
    console.warn("Could not read the mirrored entry before committing.");
  }
  // The op goes down WITH the mirror, before the POST. The user taps Save and the app is killed while
  // the request is in flight: without this there is a card on Today, a row in the mirror and
  // nothing anywhere that would ever send it, so the user sees a logged meal the server never got and
  // logs it again. A 2xx drops the op; a transient failure leaves it exactly where it is. The
  // idempotent op id is what makes writing it early safe — the same commit can queue twice and
  // still be one op (Grok pass 2, HIGH 1).
  try {
    await queue(h, req);
    // The outbox has it, so the record stops saying only this commit can send it.
    await markDurable(h, req.entry_id, true).catch(rethrowAccountChanged);
  } catch (e) {
    rethrowAccountChanged(e);
    // The post is still about to go out, so the entry is not lost — but no drain will ever settle
    // it, and the record says so for the catch-up to read (Grok pass 16, HIGH 1).
    console.warn("Could not queue the entry before committing; only the server can answer for it.");
    await markDurable(h, req.entry_id, false).catch(rethrowAccountChanged);
  }
  // Not knowing what is there means not overwriting it. The read is how a refused commit learns
  // what to put back; without it, writing the request row would replace a real revision with an
  // unacknowledged one and there would be nothing left to restore. The mark is still set and the
  // post still happens — an accepted commit mirrors the entry from the answer regardless.
  if (!before.read) return before;
  try {
    await putRow(h, "log_entries", req.entry_id, localRow(req, attemptId));
  } catch (e) {
    rethrowAccountChanged(e);
    // A blocked IndexedDB must not stop the card from appearing; the store write already did.
    console.warn("Could not mirror the entry for offline editing.");
  }
  return before;
}

/** The commit is done with this entry. A delete that landed meanwhile stays, and says so (W027). */
export async function settled(h: AccountHandle, entryId: string): Promise<{ deleted: boolean }> {
  return retirePending(h, entryId);
}

/**
 * Is the mirror in a state the mark can be cleared over? The mark says "written, not yet settled",
 * and settled means a row something can edit: complete items, and a revision. A 2xx whose entry
 * could not be read back leaves neither, and clearing the mark there tells Today the entry is
 * final while the note path and the coach's undo still refuse it (Grok pass 4, HIGH 2).
 */
export async function mirrorSettled(h: AccountHandle, entryId: string): Promise<boolean> {
  try {
    return isCompleteEntryRow(await getRow(h, "log_entries", entryId));
  } catch (e) {
    rethrowAccountChanged(e);
    return false;
  }
}
