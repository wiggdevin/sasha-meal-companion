/**
 * A picked log that cannot reach the server YET, kept whole and sent later (calc audit 2026-10-05,
 * t17 gaps 2 and 3).
 *
 * `preparePickedCommit` answers `no_ref` with `reason: "unresolved"` when the account is signed in
 * but a pick has no food ref on this phone and none can be had right now: a bundled or account food
 * picked for the first time offline (its `user_foods` adoption needs the network), or a catalog row
 * whose ref was never resolved. A meal with one such pick used to be kept on this phone only, every
 * ready item with it, and nothing ever sent it.
 *
 * Here the WHOLE entry waits instead, as one record per entry in this account's IndexedDB `meta`
 * store (`deferred_pick:<entryId>`), with its card on Today drawn as pending (`logEntryStates`). The
 * catch-up after each successful sync (`lib/sync/post-sync.ts`) runs `drainDeferredPicks`: it
 * rebuilds the commit from the stored picks, mints or resolves each missing ref through the ref
 * registry in `lib/log-client.ts` (`cachedFoodRef` / `rememberFoodRef` / `resolveFoodRef`), and
 * sends the entry down the one durable path (`commitLogEntry`). One entry, one commit: the server
 * never holds a meal with an item missing, and nothing is edited in afterwards.
 *
 * Upgrading twice is harmless. The entry id and every item id are derived from the account and the
 * picks, a ref once minted is read back from the registry, and the op id is `opIdFor(entry_id)`, so
 * a second drain of the same record builds the same request and collapses onto the first commit.
 *
 * Nothing is dropped: a record whose refs still cannot be had stays, spaced out after a few tries,
 * and goes only when its commit has been handed to the commit path (sent, queued or answered) or the
 * user deletes the card (`forgetDeferred`, called by `forgetLoggedEntry`).
 */
import {
  assertCurrent, type AccountHandle, currentAccountOrNull, rethrowAccountChanged,
} from "@/lib/device/account";
import { commitLogEntry, type CommitResult } from "@/lib/log-commit-client";
import {
  refreshCatalogPicks, type CurrentRevision,
} from "@/lib/log/deferred-refresh";
import { outcomeFor } from "@/lib/log/outcome";
import { announceLog } from "@/lib/log/pending";
import {
  localOnlyCard, preparePickedCommit, provisionalPickedEntry, type CatalogRefResolver, type NotSent,
  type PickedCommit, type PickedCommitInput, type RefMinter,
} from "@/lib/log/picked-commit";
import {
  deferredKey as keyFor, readAllDeferred, readDeferred, type DeferredPickedCommit,
} from "@/lib/log/deferred-store";
import { removeExtra, updateExtra, upsertExtra } from "@/lib/store";
import { deleteMeta, putMeta } from "@/lib/sync/idb";
import type { LoggedFood } from "@/lib/types";

export {
  deferredEntryIds, forgetDeferred, readAllDeferred, readDeferred, refusedDeferred,
  type DeferredPickedCommit,
} from "@/lib/log/deferred-store";

/** Every drain may try a record this many times before the tries space out. */
export const DEFERRED_FREE_ATTEMPTS = 5;
/** The first spaced gap, doubling, capped at `DEFERRED_MAX_GAP_MS`. A record is never dropped. */
export const DEFERRED_BACKOFF_MS = 60_000;
export const DEFERRED_MAX_GAP_MS = 6 * 60 * 60_000;

export type Deferred = { status: "deferred"; date: string; entry: LoggedFood };

/**
 * Keep a signed-in pick (or meal) whose refs cannot be had right now as one pending entry: the
 * record first, then the card on Today. Answers the plain `NotSent` it was given when the entry
 * cannot be deferred — signed out, a precheck failure, or a database that refused the record —
 * and the caller keeps its local card exactly as before.
 */
export async function deferPickedCommit(
  input: PickedCommitInput, notSent: NotSent,
): Promise<Deferred | NotSent> {
  if (notSent.status !== "no_ref" || notSent.reason !== "unresolved") return notSent;
  const h = input.account === undefined ? currentAccountOrNull() : input.account;
  if (h === null) return notSent;
  const at = input.at ?? new Date();
  const tz = input.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const provisional = await provisionalPickedEntry({ ...input, at, tz }, h);
  if (!provisional) return notSent;
  const record: DeferredPickedCommit = {
    entryId: provisional.entryId, userId: h.userId, picks: input.picks, slot: input.slot,
    ...(input.meal ? { meal: input.meal } : {}),
    at: at.toISOString(), tz, localDate: provisional.date, card: provisional.entry,
    createdAt: new Date().toISOString(), attempts: 0, nextAttemptAt: 0,
  };
  try {
    // The record before the card: a card with nothing behind it is a meal nothing would send.
    await putMeta(h, keyFor(record.entryId), record);
  } catch (e) {
    rethrowAccountChanged(e);
    return notSent;
  }
  upsertExtra(record.localDate, record.card);
  announceLog();
  return { status: "deferred", date: record.localDate, entry: record.card };
}

/**
 * `commitPickedFoods`, with the deferral: a pick whose ref cannot be had right now is kept as a
 * pending entry instead of a local-only card. The label path and any caller that wants one call.
 */
export async function commitOrDeferPickedFoods(
  input: PickedCommitInput & { fetchImpl?: typeof fetch },
): Promise<PickedCommit | Deferred> {
  const prepared = await preparePickedCommit(input);
  if (prepared.status !== "ready") return deferPickedCommit(input, prepared);
  const result = await commitLogEntry(prepared.req, {
    optimistic: { date: prepared.date, entry: prepared.entry }, account: prepared.account,
    fetchImpl: input.fetchImpl,
  });
  return { status: "sent", date: prepared.date, entry: prepared.entry, result };
}

export type DrainOptions = {
  mint?: RefMinter; catalogRef?: CatalogRefResolver; fetchImpl?: typeof fetch; now?: number;
};

export type DrainReport = {
  /** Handed to the commit path, with what it answered. Their records are gone. */
  committed: { entryId: string; result: CommitResult }[];
  /** Refused by the server. Record and card kept, the card marked `notSaved` (round 2). */
  refused: { entryId: string; result: CommitResult; reason: string }[];
  /** Still waiting for a ref. Their records stay. */
  waiting: string[];
};

function nextGap(attempts: number): number {
  if (attempts < DEFERRED_FREE_ATTEMPTS) return 0;
  return Math.min(DEFERRED_MAX_GAP_MS, DEFERRED_BACKOFF_MS * 2 ** (attempts - DEFERRED_FREE_ATTEMPTS));
}

async function countMiss(h: AccountHandle, record: DeferredPickedCommit, now: number): Promise<void> {
  const attempts = record.attempts + 1;
  try {
    // Only over a record that is still there: a delete in between is the user's last word.
    if (await readDeferred(h, record.entryId) === undefined) return;
    await putMeta(h, keyFor(record.entryId), { ...record, attempts,
      nextAttemptAt: now + nextGap(attempts) });
  } catch (e) {
    rethrowAccountChanged(e);
  }
}

/**
 * Upgrade every deferred entry whose refs can now be had, and commit it. Called by the catch-up
 * after a successful sync. Each record is tried at most once per call.
 */
export async function drainDeferredPicks(
  h: AccountHandle, opts: DrainOptions = {},
): Promise<DrainReport> {
  const now = opts.now ?? Date.now();
  const report: DrainReport = { committed: [], refused: [], waiting: [] };
  for (const record of await readAllDeferred(h)) {
    // A refusal waits for the user's retry (`retryDeferred`): sending the same entry again would
    // only be refused again.
    if (record.refused) continue;
    if (record.nextAttemptAt > now) { report.waiting.push(record.entryId); continue; }
    const prepared = await preparePickedCommit({
      picks: record.picks, slot: record.slot, meal: record.meal, at: new Date(record.at),
      tz: record.tz, entryId: record.entryId, account: h,
      ...(opts.mint ? { mint: opts.mint } : {}),
      ...(opts.catalogRef ? { catalogRef: opts.catalogRef } : {}),
    });
    if (prepared.status !== "ready") {
      await countMiss(h, record, now);
      report.waiting.push(record.entryId);
      continue;
    }
    // Asked again right before the commit, and the commit is CALLED in the same turn the answer
    // arrives in: it claims the entry synchronously, so a delete after this point finds a commit
    // posting (`isCommitting`) and is honoured by that commit's own settle.
    if (await readDeferred(h, record.entryId) === undefined) continue;
    const result = await commitLogEntry(prepared.req, {
      optimistic: { date: prepared.date, entry: prepared.entry }, account: h, automatic: true,
      fetchImpl: opts.fetchImpl,
    });
    // Another tab is posting this very entry: its commit owns it, and the next drain finds the
    // same request again if that one is lost.
    if (result.status === "owned_elsewhere") { report.waiting.push(record.entryId); continue; }
    if (isRefusal(result)) {
      const reason = await keepRefused(h, record, prepared.entry, result);
      if (reason !== null) report.refused.push({ entryId: record.entryId, result, reason });
      continue;
    }
    try {
      await deleteMeta(h, keyFor(record.entryId));
    } catch (e) {
      // The record stays; the next drain builds the same request and the server collapses it.
      rethrowAccountChanged(e);
    }
    report.committed.push({ entryId: record.entryId, result });
  }
  if (report.committed.length > 0 || report.refused.length > 0) announceLog();
  return report;
}

/** The server said no: not a deletion by the user, not another tab, and nothing kept. */
function isRefusal(result: CommitResult): boolean {
  if (result.status === "discarded" || result.status === "owned_elsewhere") return false;
  return !outcomeFor(result).keep;
}

/** Words for the card: why it is not saved and what to do. */
export function refusalReason(result: CommitResult): string {
  if (result.status === "stale_revision") {
    return "Not saved: a food in it changed in the catalog. Log it again to save it.";
  }
  if (result.status === "invalid") return "Not saved: the server could not accept it as sent.";
  return "Not saved: the server would not take it. Try again.";
}

/**
 * A refused deferred log never vanishes (t17 round 2, GPT-6 BLOCK 1). The commit's own rollback
 * took the card off Today; it goes back as a local card that owes the server nothing
 * (`localOnlyCard`) and says why (`notSaved`), and the record stays, marked refused, so the user
 * can retry it (`retryDeferred`) or delete it. Null when the user deleted it meanwhile.
 */
async function keepRefused(
  h: AccountHandle, record: DeferredPickedCommit, entry: LoggedFood, result: CommitResult,
): Promise<string | null> {
  const reason = refusalReason(result);
  try {
    if (await readDeferred(h, record.entryId) === undefined) return null;
    await putMeta(h, keyFor(record.entryId), { ...record,
      refused: { status: result.status, reason, at: new Date().toISOString() } });
  } catch (e) {
    // The record could not be marked: it stays as it was and the card still comes back.
    rethrowAccountChanged(e);
  }
  upsertExtra(record.localDate, { ...localOnlyCard(entry), notSaved: reason });
  return reason;
}

export type RetryResult =
  /** Back to waiting; the next drain sends it. `repinned`: a catalog line moved to a new revision. */
  | { status: "waiting"; repinned: boolean }
  /** Still not saved: a catalog food is gone, or the catalog cannot be asked right now. */
  | { status: "gone" | "offline"; reason: string }
  | { status: "none" };

/**
 * The user asks to send a refused log again. A refusal for a stale catalog revision is first
 * re-pinned to each food's CURRENT revision (lib/log/deferred-refresh.ts, t17 round 3) — sending
 * the old pin again would only be refused again. If a food has no usable revision, or the catalog
 * cannot be reached, the card stays not saved with a reason that says so. Otherwise the record goes
 * back to waiting with its rebuilt card, and the next drain prepares and sends it.
 */
export async function retryDeferred(
  h: AccountHandle, entryId: string, opts: { currentRevision?: CurrentRevision } = {},
): Promise<RetryResult> {
  const record = await readDeferred(h, entryId);
  if (!record?.refused) return { status: "none" };
  let picks = record.picks;
  let repinned = false;
  if (record.refused.status === "stale_revision") {
    const refreshed = await refreshCatalogPicks(record.picks, h, opts.currentRevision);
    if (refreshed.status !== "ok") {
      const reason = refreshed.status === "gone"
        ? `Not saved: ${refreshed.name} is no longer in the catalog. Log it again with another food.`
        : "Not saved: the catalog cannot be reached right now. Try again when you are online.";
      await putMeta(h, keyFor(entryId), { ...record,
        refused: { ...record.refused, reason, at: new Date().toISOString() } });
      assertCurrent(h);
      updateExtra(record.localDate, entryId, { notSaved: reason });
      announceLog();
      return { status: refreshed.status, reason };
    }
    picks = refreshed.picks;
    repinned = refreshed.changed;
  }
  // The card the waiting entry shows, rebuilt from the picks it will now send.
  const provisional = await provisionalPickedEntry({ picks, slot: record.slot, meal: record.meal,
    at: new Date(record.at), tz: record.tz, entryId, account: h }, h);
  const card = provisional?.entry ?? record.card;
  const { refused: _refused, ...rest } = record;
  void _refused;
  await putMeta(h, keyFor(entryId), { ...rest, picks, card, attempts: 0, nextAttemptAt: 0 });
  // The not-saved card goes back to the waiting one (`upsertExtra` merges fields, so the
  // `localOnly` and `notSaved` marks are taken off by replacing the card, not patching it).
  assertCurrent(h);
  removeExtra(record.localDate, entryId);
  upsertExtra(record.localDate, card);
  announceLog();
  return { status: "waiting", repinned };
}
