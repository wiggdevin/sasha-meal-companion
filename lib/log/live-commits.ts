/**
 * Which entries have a commit POSTing right now — in this tab, and in any other tab of this app.
 *
 * Distinct from the durable record in `lib/log/pending.ts`, and deliberately so: that record
 * survives a kill and carries the retry semantics, but it cannot tell you whether a request is
 * actually in the air — after a kill it says `in_flight` about a POST that no longer exists
 * anywhere, and anything treating it as a lock waits on a process that is gone (panel round 15).
 *
 * A module map alone is not enough either. Two documents of this PWA share IndexedDB — the outbox,
 * the mirror, these records — and share no memory at all, so the other tab's drain saw no live
 * commit while this one's POST was open (Grok pass 8, HIGH 1). The boundary that crosses a tab is
 * the Web Locks API, which the parked weigh-ins already use: the commit holds a lock named for its
 * entry for as long as the request is live, and the drain asks for it without waiting — through
 * `lib/log/web-lock.ts`, which bounds every such ask. The browser
 * releases a lock when its tab dies, so a killed-mid-post entry is free again with no timeout to
 * pick — and the map is still the answer where the API is missing (older WebKit, and Node).
 */
import { DEADLINES } from "@/lib/fetch-with-deadline";
import { acquireBounded, isHeld } from "@/lib/log/web-lock";

/** The promise, and when the hold started — the drain stops believing a hold past the budget. */
type Hold = { work: Promise<unknown>; since: number };

const live = new Map<string, Hold>();

const LOCK_PREFIX = "mc-log-commit:";

/**
 * The longest a commit is treated as POSTING for anyone else's purposes. A commit that never
 * reaches its POST — a blocked IndexedDB, a write that never settles — would otherwise hold the
 * entry for the life of the page and leave every later drain standing off for ever (Grok pass 8,
 * LOW 1). Within it, a second commit for the same entry JOINS rather than running beside it
 * (Grok pass 9, HIGH 2); past it, nothing is joined and a new commit may go.
 */
export const HOLD_BUDGET_MS = DEADLINES.commit + 5_000;

/**
 * Claim the entry in THIS tab, synchronously, so a second `commitLogEntry` in the same turn joins
 * this one rather than starting beside it. Returns the release for its `finally`.
 */
export function claimCommit(entryId: string, work: Promise<unknown>): () => void {
  live.set(entryId, { work, since: Date.now() });
  return () => { if (live.get(entryId)?.work === work) live.delete(entryId); };
}

/**
 * Ask the other tabs for this entry — and WAIT to find out whether you have it.
 *
 * `null` means another tab owns this entry, and the only correct thing to do with it is nothing.
 * The ask is bounded by the budget every lock in the commit path shares (`lib/log/web-lock.ts`):
 * a browser that will not answer must not be able to stop a save, and the card is budgeted at
 * 100 ms from the tap.
 */
export function acquireCommitLock(entryId: string): Promise<(() => void) | null> {
  return acquireBounded(LOCK_PREFIX + entryId);
}

/**
 * The commit already posting this entry in THIS tab — the one a second tap joins rather than
 * running beside (Grok pass 9, HIGH 2).
 *
 * Past the budget there is nothing to join. `isCommitting` already tells the drain and the card's
 * own retry that the entry is free, and handing them a promise that will never post again is the
 * one way those two answers can disagree: the tap hung instead of sending (pass 25, MEDIUM 3).
 */
export function joinCommit(entryId: string, now: number = Date.now()): Promise<unknown> | undefined {
  const held = live.get(entryId);
  return held && now - held.since < HOLD_BUDGET_MS ? held.work : undefined;
}

/**
 * Is a commit posting this entry anywhere? The ask does not wait for a turn, and does not wait on
 * a browser that will not answer.
 *
 * A hold of this tab's own that has outlived the budget answers no: whatever it is doing, it has
 * stopped being a request anyone else should wait behind.
 */
export async function isCommitting(entryId: string, now: number = Date.now()): Promise<boolean> {
  const held = live.get(entryId);
  if (held && now - held.since < HOLD_BUDGET_MS) return true;
  if (held) return false;
  return isHeld(LOCK_PREFIX + entryId);
}

/**
 * Entries the user deleted while a commit for them was still posting.
 *
 * The delete cannot be applied yet — the POST is in the air, and its settle would draw the card
 * again and mirror the row — so it is remembered here and applied when that commit settles
 * (Grok pass 11, HIGH 2). In-process by nature: only this tab's commit can honour it, and a tab
 * that dies with one pending leaves the entry to the drain and the next pull, which is the state
 * it was in before the user deleted it.
 */
const deletedWhileLive = new Set<string>();

/** Phase 9 §0.3: forget the last account's live commits. Their own settle stops at its handle
 *  check; the cross-tab locks are released by their own `finally`. */
export function resetLiveCommits(): void {
  live.clear();
  deletedWhileLive.clear();
}

export function rememberDelete(entryId: string): void {
  deletedWhileLive.add(entryId);
}

/** Was this entry deleted while its commit was posting? Asked once, by that commit's settle. */
export function takeDelete(entryId: string): boolean {
  return deletedWhileLive.delete(entryId);
}
