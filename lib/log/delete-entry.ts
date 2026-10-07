/**
 * Their delete, and everything it has to reach.
 *
 * Taking the card off the day is the last word on that entry, and the app has four other places
 * that would otherwise bring it back: the write queued before the POST, which the drain would send;
 * the mirror row, which the next pull would re-render; a commit still in the air, whose settle
 * would draw the card and mirror the row again; and the server itself, if it has taken the entry.
 *
 * The delete is therefore a durable RECORD STATE rather than a flag in one tab's heap: the commit
 * that has to honour it may be in another tab, a retryable answer (a timeout, a 5xx, a lapsed
 * session) would otherwise write the same create straight back into the outbox, and a page that
 * dies between their delete and the server delete must still finish the job on the next launch
 * (Grok pass 11, HIGH 2; Grok pass 12, HIGH 1 and MEDIUM 1).
 */
import {
  accountHandle, assertCurrent, isCurrent, type AccountHandle,
} from "@/lib/device/account";
import { browserClient } from "@/lib/supabase/client";
import { withAccount } from "@/lib/device/account-supabase";
import { withinBudget } from "@/lib/fetch-with-deadline";
import { getDay, removeExtra } from "@/lib/store";
import type { LoggedFood } from "@/lib/types";
import { forgetDeferred } from "@/lib/log/deferred-store";
import { isCommitting } from "@/lib/log/live-commits";
import {
  clearPending, countAttempt, isDeleted, markDeleted, type PendingLogEntry, readPendingOrNull,
  readyNow, recordFor,
} from "@/lib/log/pending";
import { dropQueuedOps, hasQueuedOp } from "@/lib/log-commit-settle";
import { deleteRow, getRow } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";

export { isDeleted };

/**
 * The user took the card off the day themselves. Everything local goes at once; what the server holds is
 * settled by `finishDelete`, now or on the next pass.
 */
export async function forgetLoggedEntry(
  date: string, entryId: string, h: AccountHandle = accountHandle(),
): Promise<void> {
  // Read before the row goes: a mirror row with a revision is the server having this entry, and
  // after a settled commit the record itself is gone, so this is the only thing left that knows.
  // A deferred picked log (lib/log/picked-deferred.ts) goes first, so no drain sends it from here on.
  const deferred = await forgetDeferred(h, entryId);
  const mirror = await mirrorRow(h, entryId);
  const mirrored = typeof mirror === "object" && typeof mirror?.rev === "number" ? mirror.rev : null;
  const card = getDay(date)?.extras?.find((extra) => extra.id === entryId);
  const queued = await hasQueuedOp(h, entryId);
  const records = await readPendingOrNull(h);
  assertCurrent(h);
  removeExtra(date, entryId);
  // The write queued before the POST goes with the card: leaving it in the outbox means the drain
  // creates the meal the user has just deleted and the next pull puts it back on Today.
  await dropQueuedOps(h, entryId);
  await deleteRow(h, "log_entries", entryId).catch(() => undefined);
  if (neverOnTheWire(records, queued, mirror, card, entryId)
    || (deferred === true && !await isCommitting(entryId)
      && nothingSent(records, queued, mirror, entryId))) {
    await clearPending(h, entryId);
    return;
  }
  await markDeleted(h, entryId, { confirmed: mirrored !== null });
  await finishDelete(h, entryId);
}

/**
 * Tell the server to drop an entry it has taken, and retire the record.
 *
 * Three ways this ends, and the server decides which. It has no such row — or a tombstoned one —
 * so there is nothing to tell it and the record goes. It answers with a revision, so the delete is
 * queued at THAT revision and the record goes once that queue write lands. Or the read fails, and
 * the record stays `deleted` for the catch-up to try again: a delete aimed at no revision is worse
 * than a late one (Grok pass 12, HIGH 2).
 */
export async function finishDelete(h: AccountHandle, entryId: string): Promise<boolean> {
  // A live commit owns this entry until it answers; its own settle calls `completeDelete` below.
  if (await isCommitting(entryId)) return true;
  return completeDelete(h, entryId);
}

/** True when there is nothing left to tell the server — the record is gone or was never owed. */
async function completeDelete(h: AccountHandle, entryId: string): Promise<boolean> {
  const record = await recordFor(h, entryId);
  if (record?.state !== "deleted") return true;
  // ALWAYS ask the server, whatever this phone managed to hear about the write. `confirmed` is
  // false for an in-flight create — the mirror has no revision yet — so treating it as "the server
  // is empty" cleared the tombstone for a meal the server had, and the next pull restored it
  // (Grok pass 13, HIGH 1).
  const rev = await serverRevOf(h, entryId);
  if (rev === "unreadable") return false;
  if (rev === "gone") {
    await clearPending(h, entryId);
    return true;
  }
  // And the record goes only once the delete is durably queued: an enqueue that failed used to
  // take the only lasting "tell the server" bit with it (Grok pass 13, HIGH 2).
  if (!await queueDelete(h, entryId, rev)) return false;
  await clearPending(h, entryId);
  return true;
}

/**
 * The revision the server holds for this entry, or that it holds nothing worth deleting.
 *
 * Bounded like every other hop the user waits on: a read that never answers would otherwise hold the
 * whole catch-up open behind one entry (Grok pass 13, MEDIUM 4).
 */
async function serverRevOf(h: AccountHandle, entryId: string): Promise<number | "gone" | "unreadable"> {
  return withinBudget(readServerRev(h, entryId), "commit", "unreadable");
}

async function readServerRev(h: AccountHandle, entryId: string): Promise<number | "gone" | "unreadable"> {
  try {
    // Phase 9 §0.5a: an answer read under another account's session says nothing about this one.
    const current = await withAccount(h, () => browserClient().from("log_entries")
      .select("id, rev, deleted_at").eq("id", entryId).maybeSingle());
    if (current.error) throw new Error("Could not read the entry to delete.");
    const row = current.data as { rev?: unknown; deleted_at?: unknown } | null;
    // A tombstoned row is the ONLY answer that ends the matter. A read with no row at all, or one
    // whose revision is not a number, is this read not seeing the entry — replica lag, or the
    // window after a POST the client never heard about — and treating either as "the server has
    // nothing" cleared the tombstone and queued no delete (Grok pass 14, HIGH 1).
    if (row !== null && row.deleted_at) return "gone";
    if (typeof row?.rev === "number") return row.rev;
    return "unreadable";
  } catch {
    if (!isCurrent(h)) return "unreadable";
    console.warn("Could not read the revision to delete an entry at; will try again.");
    return "unreadable";
  }
}

/** Queue the delete the drain will send. Never at a revision the server has not confirmed. */
async function queueDelete(h: AccountHandle, entryId: string, baseRev: number): Promise<boolean> {
  try {
    await enqueue(h, {
      op_id: crypto.randomUUID(), entity: "log_entries", entity_id: entryId,
      kind: "delete", base_rev: baseRev, payload: {}, client_ts: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    if (!isCurrent(h)) throw e;
    console.warn("Could not queue the delete for an entry the server already has.");
    return false;
  }
}

/**
 * A commit answered about an entry the user has deleted. Nothing draws the card, nothing mirrors the
 * row, and an answer of any shape that proves the server has the entry — a 2xx, a conflict, a
 * drain's `applied` or `duplicate` — leaves the server delete to `finishDelete`.
 */
export async function settleDeletedEntry(
  h: AccountHandle,
  entryId: string, date: string | undefined,
): Promise<void> {
  assertCurrent(h);
  if (date !== undefined) removeExtra(date, entryId);
  await dropQueuedOps(h, entryId);
  await deleteRow(h, "log_entries", entryId).catch(() => undefined);
  // `completeDelete`, not `finishDelete`: this IS that commit's settle, so the hold it still has
  // on the entry is its own and must not stand in the way of honouring their delete.
  await completeDelete(h, entryId);
}

/**
 * Every delete this account still owes the server, tried once. Called by the sync catch-up.
 *
 * Bounded exactly like a read-back: the same spacing between tries, and the same cap. A delete
 * nobody can aim — an entry whose revision never reads back — would otherwise ask the server on
 * every sync for as long as the app is installed (Grok pass 13, MEDIUM 4). Past the cap the record
 * turns `stale`: still theirs, still not drawn, and warned about once.
 */
export async function finishPendingDeletes(
  h: AccountHandle,
  owed: PendingLogEntry[], now: number = Date.now(),
): Promise<void> {
  for (const record of owed) {
    if (!await deleteReady(h, record, now)) continue;
    if (await finishDelete(h, record.entryId)) continue;
    await countAttempt(h, record.entryId, now);
  }
}

async function deleteReady(h: AccountHandle, record: PendingLogEntry, now: number): Promise<boolean> {
  if (record.userId === null) return record.nextAttemptAt <= now;
  return readyNow(h, record.entryId, record.userId, now);
}

/**
 * Was this entry only ever on this phone — a bundled pick, or one of their own foods, put straight
 * onto the day with no commit behind it? Then there is nothing to tell the server.
 *
 * Every part of that has to be POSITIVE. "No record, no queued write, no mirrored row" is also
 * what a database that cannot be read answers, and a catalog save still posting looks exactly
 * like that with IndexedDB flaky — its own 2xx would then put the meal back (Grok pass 26,
 * HIGH 3). So a failed read is never evidence, and the card has to say what it is: no revision,
 * no catalog food behind it (or an explicit `localOnly` mark), and every line of it under a ref
 * the wire never carried.
 */
function neverOnTheWire(
  records: PendingLogEntry[] | null, queued: boolean | "unknown",
  mirror: Row | undefined | "unreadable", card: LoggedFood | undefined, entryId: string,
): boolean {
  if (records === null || queued !== false || mirror === "unreadable") return false;
  if (records.some((r) => r.entryId === entryId) || mirror !== undefined) return false;
  if (card === undefined || card.rev !== undefined) return false;
  // A catalog food behind the card means a commit may be in the air — unless the card itself says
  // it was kept local after a not-sent answer (`localOnlyCard`), which no commit ever follows.
  if (card.foodId.startsWith("catalog:") && card.localOnly !== true) return false;
  return (card.items ?? []).every((item) => item.food_ref_id.startsWith("local:"));
}

/**
 * A deferred entry's card can carry real refs (a catalog line, a ref minted for one pick) and still
 * never have been sent: the drain sends the whole entry or nothing. With its record taken and no
 * commit posting it, what proves that is the same positive evidence `neverOnTheWire` asks for —
 * no commit record, no queued write and no mirrored row — without reading the card's refs.
 */
function nothingSent(
  records: PendingLogEntry[] | null, queued: boolean | "unknown",
  mirror: Row | undefined | "unreadable", entryId: string,
): boolean {
  if (records === null || queued !== false || mirror !== undefined) return false;
  return !records.some((r) => r.entryId === entryId);
}

type Row = Record<string, unknown>;

/** The mirrored row, or the news that the database could not be asked about it. */
async function mirrorRow(h: AccountHandle, entryId: string): Promise<Row | undefined | "unreadable"> {
  try {
    return await getRow(h, "log_entries", entryId) as Row | undefined;
  } catch (e) {
    if (!isCurrent(h)) throw e;
    return "unreadable";
  }
}

/** Whether the mirror still holds this entry — used only to decide if a delete is worth queuing. */
export async function mirrorRevOf(h: AccountHandle, entryId: string): Promise<number | null> {
  const row = await getRow(h, "log_entries", entryId).catch(() => undefined);
  return typeof row?.rev === "number" ? row.rev : null;
}
