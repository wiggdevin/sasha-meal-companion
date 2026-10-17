/**
 * `commitLogEntry` and everything that settles one — the local-first write, the mirror row, the
 * reconcile against the server's answer, the rollback, the outbox. Split out of lib/log-client.ts
 * when that file passed 500 lines (Grok 4.6 MEDIUM 13); no behaviour moved with it.
 *
 * The rule the whole file turns on: the local write happens FIRST, for every commit, and only a
 * transient failure may reach the outbox — once the server has answered 2xx it holds the entry,
 * and a queued replay would commit it twice.
 */
import {
  AccountChanged, accountFetch, accountHandle, assertCurrent, rethrowAccountChanged,
  type AccountHandle,
} from "@/lib/device/account";
import type { LogCommitFailure, LogCommitRequest, LogCommitResponse }
  from "@/lib/log/contract";
import { acquireCommitLock, claimCommit, joinCommit } from "@/lib/log/live-commits";
import { getDay, upsertExtra } from "@/lib/store";
import { announceLog, clearPending, confirmEntry, markNeedsReconcile } from "@/lib/log/pending";
import { isDeleted, settleDeletedEntry } from "@/lib/log/delete-entry";
import { safeQueue } from "@/lib/log/queue-commit";
import { isAccepted, readResult } from "@/lib/log/read-result";
import { announceQueued } from "@/lib/sync/outbox";
import { mirrorSettled, recordFirst, settled, writeLocalFirst } from "@/lib/log/local-first";
import { dropMark, mark, measure, newRunId, type TimingPath, type TimingRun } from "@/lib/timing";
import type { LoggedFood } from "@/lib/types";
import {
  dropCommitOp, hasQueuedOp, settleAccepted, settleRefused,
  type CommitAccepted, type CommitRefused, type OptimisticWrite, type ReconcileOutcome,
} from "@/lib/log-commit-settle";

export type { CommitAccepted, CommitRefused, OptimisticWrite } from "@/lib/log-commit-settle";
export { reconcileEntry, reconcileFromEntity, retryPendingReconciles } from "@/lib/log-commit-settle";
export { outcomeFor, type CommitOutcome } from "@/lib/log/outcome";
export { isAccepted } from "@/lib/log/read-result";
export { logEntryStates, pendingEntryIds, type LogEntryStates } from "@/lib/log/today-state";
export { forgetLoggedEntry } from "@/lib/log/delete-entry";
export { retryUnsavedCommit } from "@/lib/log/retry-unsaved";
export { LOG_QUEUED_EVENT } from "@/lib/log/pending";

// ------------------------------------------------------------------ commit

/**
 * A session lapse (401), a slow link (408) and a throttle (429) are all transient: the same payload
 * applied later is still correct, so it goes to the outbox. Every other 4xx (400/409/410/422) is a
 * genuine rejection — queuing one would loop forever — and its body is returned to the caller.
 */
const RETRY_STATUSES = new Set([401, 408, 429]);

/** Everything `commitLogEntry` can answer. */
export type CommitResult =
  LogCommitResponse | LogCommitFailure | CommitAccepted | CommitRefused
  | { status: "queued" }
  /** Another tab is posting this entry. This one wrote nothing and queued nothing. */
  | { status: "owned_elsewhere" }
  /** The user deleted this entry while it was saving. Their delete was honoured; there is no card. */
  | { status: "discarded" }
  /** Posted, but nothing could be queued behind it. The card stays; the catch-up asks the server. */
  | { status: "unqueued" }
  /** The server answered and nobody could read it. The card stays; the catch-up asks the server. */
  | { status: "unsettled" };

/**
 * The card as it stands NOW, after the commit has reconciled it — which is what a sheet must hand
 * on, never the object it built before the server had spoken. `upsertExtra` replaces by id, so
 * passing the pre-server copy overwrites the off-plan flags and the grams the reply just put
 * there (Grok 4.6 HIGH 2). Falls back to the object given when no card was written.
 */
export function committedEntry(date: string, fallback: LoggedFood): LoggedFood {
  return getDay(date)?.extras?.find((entry) => entry.id === fallback.id) ?? fallback;
}

function since(started: number): number {
  const perf = globalThis.performance;
  return (typeof perf?.now === "function" ? perf.now() : Date.now()) - started;
}

function startedAt(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

/**
 * The commit closes the run (T0 §1): `timingPath` says which one, so the scanner's `decode`, the
 * barcode client's `lookup` and this commit all land under one `run_id`. `commit` is the whole
 * tap-to-acknowledged time and `card-visible` is how long the card took to appear, which is the
 * ≤ 100 ms budget of spec §6. No path means no measurement — a coach-applied action closes its
 * own run elsewhere.
 */
export function commitLogEntry(
  req: LogCommitRequest,
  opts: CommitOptions = {}
): Promise<CommitResult> {
  // Phase 9 §0.2: the account is taken once, here, and every step after this uses it.
  const h = opts.account ?? accountHandle();
  // A second call for an entry that is already posting JOINS it. Two POSTs for one entry are two
  // settle paths racing on it — and a second queued change for a commit that already has one —
  // which is the same class of bug as a drain landing mid-post (panel round 15).
  const joined = joinCommit(req.entry_id) as Promise<CommitResult> | undefined;
  if (joined) return joined;
  let release = (): void => {};
  // The entry is claimed BEFORE anything is written or sent, and the claim is awaited: a commit
  // that posts first and finds out afterwards is two tabs posting one entry (Grok pass 9, HIGH 1).
  let unclaim = (): void => {};
  const work = (async (): Promise<CommitResult> => {
    const lock = await acquireCommitLock(req.entry_id);
    if (lock === null) {
      // Another tab owns this entry and is posting it right now. Its card is already on Today —
      // the store is shared — and its queued change is already in the outbox. A second POST and a
      // second queued change would only race it.
      console.warn("Another tab is already saving that entry.");
      // NOT `queued`: this tab has queued nothing, and a sheet told "queued" closes as if the
      // meal were on its way from here (Grok pass 10, MEDIUM 1).
      return { status: "owned_elsewhere" };
    }
    release = lock;
    try {
      return await postCommit(h, req, opts);
    } catch (e) {
      // The account changed mid-commit: this tab sends and writes nothing more. What was written
      // before the switch stays in the old account's database and is retried as that account.
      if (e instanceof AccountChanged) return { status: "owned_elsewhere" };
      throw e;
    }
  })();
  const released = work.finally(() => {
    // The claim first: dropping the cross-tab lock while this tab still looks busy to itself lets
    // another tab in against a tab that will not join it (Grok pass 18, MEDIUM 3). Then, with the
    // entry nobody's, the wake: every drain woken while it was held skipped it (pass 17, HIGH 1).
    unclaim();
    release();
    void wakeIfQueued(h, req.entry_id);
  });
  // Claimed in the same turn as the call, so a second tap joins this promise; the lock above is
  // what the OTHER tabs see, and it is taken before anything is written or sent.
  unclaim = claimCommit(req.entry_id, released);
  return released;
}

/** The wake a drain can act on: the entry is nobody's now, and its write is still waiting. */
async function wakeIfQueued(h: AccountHandle, entryId: string): Promise<void> {
  try {
    if (await hasQueuedOp(h, entryId) === true) announceQueued();
  } catch {
    // Fire-and-forget: the account changed (the only error hasQueuedOp lets out), so there is
    // nothing of this account's left to wake a drain for, and nobody awaits this promise.
  }
}

type CommitOptions = {
  fetchImpl?: typeof fetch; optimistic?: OptimisticWrite; timingPath?: TimingPath;
  /** Nobody asked for this one: the catch-up sent it. Only THEIR commit revives a capped record. */
  automatic?: boolean;
  /** The run this commit closes. A caller that can have two taps in flight passes its own. */
  run?: TimingRun;
  /** The account a delayed caller (the catch-up, a retry) started as. Default: the bound one. */
  account?: AccountHandle;
};

async function postCommit(
  h: AccountHandle,
  req: LogCommitRequest,
  opts: CommitOptions,
): Promise<CommitResult> {
  const optimistic = opts.optimistic;
  const path = opts.timingPath;
  const run = opts.run;
  const tapped = startedAt();
  if (path) mark(path, "commit", run);
  // The record first, then the card, then the sample. Today repaints on the record's own event,
  // so the paint is the announce after the store write — and what the budget covers is everything
  // the user waits on for it: the record, because there is no card without one, and nothing after it,
  // because the outbox and the mirror happen behind a card that is already up (Grok pass 20,
  // MEDIUM 3; Grok pass 21, HIGH 1 and MEDIUM 2).
  await recordFirst(h, req, opts.automatic === true, optimistic?.entry);
  if (optimistic) {
    assertCurrent(h);
    upsertExtra(optimistic.date, optimistic.entry);
    announceLog();
  }
  const cardMs = optimistic ? since(tapped) : null;
  const before = await writeLocalFirst(h, req);
  const close = (): void => {
    if (!path) return;
    measure(path, run ?? newRunId(), {
      commit: since(tapped),
      ...(cardMs === null ? {} : { "card-visible": cardMs }),
    });
  };
  /**
   * A commit that ends in the outbox is not a `commit` sample: it has NOT happened yet — it
   * happens when the drain sends it — and filing it would make p95 a number about failures rather
   * than about the taps §6 judges (Grok pass 5, MEDIUM 6).
   *
   * The CARD still went up, though, and §6 budgets tap-to-card on the server-down path as much as
   * the happy one. So the commit step is dropped and the run is closed with whatever it has left
   * — which for a commit with no card at all is nothing, and buffers nothing (Grok pass 6,
   * MEDIUM 5).
   */
  const queuedClose = (): void => {
    if (!path) return;
    dropMark(path, "commit", run);
    measure(path, run ?? newRunId(), cardMs === null ? {} : { "card-visible": cardMs });
  };
  let res: Response;
  try {
    res = await accountFetch(h, "/api/log/commit", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(req),
    }, { budget: "commit", fetchImpl: opts.fetchImpl });
  } catch (e) {
    rethrowAccountChanged(e);
    // Nothing reached the server, or nothing came back. The same payload applied later is still
    // correct, so it goes to the outbox.
    const queued = await safeQueue(h, req, optimistic);
    queuedClose();
    return queued;
  }

  if (res.status >= 500 || RETRY_STATUSES.has(res.status)) {
    const queued = await safeQueue(h, req, optimistic);
    queuedClose();
    return queued;
  }

  /*
   * Past this line the server has answered and is not asking to be retried, so NOTHING may reach
   * the outbox: the entry is the server's now, and a queued replay of an entry it already holds
   * is a second commit. Every step below is therefore allowed to fail — a body that is not
   * contract-shaped, a mirror write that throws — and none of them may change what this function
   * returns, which is the server's own answer.
   */
  const answer = await readResult(res);
  assertCurrent(h); // a body read after a switch belongs to nobody (audit plan r2 finding 8)
  // An answer nobody could read. A 410 is the exception: the server saying the entry is gone
  // needs no body to be read, and this commit already knows what to do with a tombstone — roll
  // back, take the card off, and send nothing again (Grok pass 27, HIGH 1).
  const unread = answer.status === "unread";
  const result = unread && answer.http === 410 ? { status: "gone" } as LogCommitFailure : answer;
  // A 409 still proves the row exists, so the record is confirmed and waits for the read-back;
  // anything else keeps everything it has and lets the catch-up ask the server. Either way
  // nothing is taken back on it (Grok pass 26, HIGH 1).
  if (unread && answer.http === 409) await confirmEntry(h, req.entry_id);
  const accepted = isAccepted(result);
  // The server has it. Everything after this is about detail, and none of it may turn the card
  // back into one that says the meal might not be saved (Grok pass 8, HIGH 2). A conflict proves
  // it too: the entry exists, another device simply got there first.
  if (accepted || result.status === "conflict") await confirmEntry(h, req.entry_id);
  // The user deleted this entry while the POST was in the air — in this tab or another one. Their delete
  // is the last word: nothing below may draw the card or mirror the row, and the server delete is
  // owed as soon as anything proves the server has it (Grok pass 12, HIGH 1).
  if (await isDeleted(h, req.entry_id)) {
    await settleDeletedEntry(h, req.entry_id, optimistic?.date);
    close();
    // NOT the server's answer: a sheet told "ok" adds the card back through its own `onAdd`, and
    // `upsertExtra` puts the meal the user deleted on the day again (Grok pass 15, HIGH 1).
    return { status: "discarded" };
  }
  if (result.status === "unread") {
    // The write queued before the POST was this commit's retry, and the server has answered it.
    // Leaving it for the drain sends the very request the route just refused (pass 27, HIGH 1).
    await dropCommitOp(h, req);
    await markNeedsReconcile(h, req.entry_id, null);
    close();
    return { status: "unsettled" };
  }
  // A conflict is the one refusal that can go either way: it keeps the card when the body hands
  // back the entity, and keeps nothing when it does not. Whatever settle actually did is what the
  // sheet is told, so the two can never disagree about one commit (Grok pass 4, MEDIUM 4).
  // False until settle says otherwise: a throw partway through a rollback has kept nothing, and
  // "conflict" over a card that has just been removed is the one answer the sheet must not give
  // (Grok pass 5, MEDIUM 4).
  let kept = false;
  /** What the authoritative read said, when one happened. A tombstone ends the matter. */
  let outcome: ReconcileOutcome | null = null;
  try {
    // The same verdict the sheet will read, so the two can never disagree about one commit.
    if (accepted) { outcome = await settleAccepted(h, req, result, before, optimistic); kept = true; }
    else kept = await settleRefused(h, req, result, before, optimistic);
  } catch (e) {
    rethrowAccountChanged(e);
    // The local copy is behind the server's. The next changes-pull replaces it either way, and
    // on an accepted commit nothing may be taken away over a local failure.
    console.warn("Could not settle the committed entry locally.", e);
  }
  // A refusal that kept nothing has nothing left pending: the entry is back out. Anything the
  // server still holds — an accepted commit, or a conflict whose entity was stored — keeps its
  // record until the mirror holds a row something can edit. `retryPendingReconciles` picks those
  // up after the next successful sync, without posting anything again.
  // A tombstone retired the record and deleted the mirror row on purpose. Asking `mirrorSettled`
  // about a row that is meant to be absent answers "incomplete", and marking on that answer makes
  // the record again — the entry was off Today and pending at once, and the next sync read it
  // again (panel round 13). The server's last word needs nothing after it.
  // The user can delete the entry DURING the settle: the read-back is a network hop, and another tab's
  // delete inside it finds this commit still holding the entry and leaves the server delete here.
  // Asked once before the settle is not enough — the answer can change while it runs (Grok pass
  // 19, HIGH 1).
  if (await isDeleted(h, req.entry_id)) {
    await settleDeletedEntry(h, req.entry_id, optimistic?.date);
    close();
    return { status: "discarded" };
  }
  const tombstoned = outcome === "deleted";
  const gone = !accepted && !kept;
  if (tombstoned) {
    // The tap still happened and the server still answered it: the entry turning out to be gone
    // is a fact about the entry, not about how long the commit took (Grok pass 7, LOW 5).
    close();
    // The server's own `ok` would have the sheet add the card back — over an entry the server has
    // already deleted, which no pull will take off Today again. A tombstone the read-back found
    // ends the commit exactly as their own delete does (Grok pass 20, HIGH 2).
    return { status: "discarded" };
  }
  if (gone || await mirrorSettled(h, req.entry_id)) {
    // Their delete can still land in the read just above: it stays, and wins (W027).
    if ((await settled(h, req.entry_id)).deleted) {
      await settleDeletedEntry(h, req.entry_id, optimistic?.date);
      // A refused create is the server saying it holds nothing: no delete is owed, and a record
      // left asking it would only read "no row" until the cap.
      if (gone && req.base_rev === undefined) await clearPending(h, req.entry_id);
      close();
      return { status: "discarded" };
    }
  } else {
    await markNeedsReconcile(h, req.entry_id, null);
    // Their delete takes the mirror row first, which is what makes it read as unsettled here.
    if (await isDeleted(h, req.entry_id)) {
      await settleDeletedEntry(h, req.entry_id, optimistic?.date);
      close();
      return { status: "discarded" };
    }
  }
  close();
  // A conflict that kept nothing is a plain refusal as far as the sheet is concerned: there is no
  // entity to describe and no card left to describe it beside.
  return result.status === "conflict" && !kept ? { status: "refused" } : result;
}
