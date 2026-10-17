/**
 * Which entries are written but not yet settled against the server.
 *
 * It was a module-level Set, which was wrong three ways (Grok pass 5): RAM only, so a kill after a
 * 2xx whose read-back failed lost the fact that the row still needed reconciling; process-global,
 * so a second account on the same phone inherited the first's; and one state for two very
 * different things — a commit still posting, and a commit the server has taken whose row this
 * phone could not read.
 *
 * So a record now, in the `meta` store of the same IndexedDB database the outbox uses, exactly the
 * shape the parked weigh-ins already use (`lib/health/weigh-in-client.ts`):
 *
 *   - **durable.** It survives a reload, and the first successful sync after one picks it up.
 *   - **owned by an account.** Every record carries the `userId` that made it; the retry reads
 *     only its own, and drops any other account's rather than reading a row under the wrong JWT.
 *   - **four states.** A commit still posting, the server's entry whose row is not here yet, one
 *     that has run out of reads, and an entry the user has deleted (`PendingState` below).
 *   - **bounded.** Attempts are counted, and a record that cannot be settled is marked with one
 *     warning rather than retried for the life of the install.
 *
 * Both halves of the app reach it — the commit path and the drain — so it is its own module.
 */
import { AccountChanged, type AccountHandle } from "@/lib/device/account";
import type { LogCommitRequest } from "@/lib/log/contract";
import type { LoggedFood } from "@/lib/types";
import { underBoundedLock } from "@/lib/log/web-lock";
import { getMeta, putMeta } from "@/lib/sync/idb";
import {
  BACKOFF_MS, FREE_ATTEMPTS, MAX_ATTEMPTS, MAX_UNCONFIRMED, type PendingLogEntry,
} from "@/lib/log/pending-types";

export const LOG_QUEUED_EVENT = "meal-companion:log-queued";

/** The `meta` key the records live under. */
export const PENDING_LOG_KEY = "pending_log_entries";

export {
  BACKOFF_MS, FREE_ATTEMPTS, MAX_ATTEMPTS, MAX_UNCONFIRMED,
  type PendingLogEntry, type PendingState,
} from "@/lib/log/pending-types";

/** Told Today to re-read what is pending. Safe where there is no window. */
export function announceLog(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOG_QUEUED_EVENT));
}

/** The records, or null when the database could not be read — which is not "there are none". */
export async function readPendingOrNull(h: AccountHandle): Promise<PendingLogEntry[] | null> {
  try {
    const stored = await getMeta(h, PENDING_LOG_KEY);
    return Array.isArray(stored) ? stored as PendingLogEntry[] : [];
  } catch (e) {
    if (e instanceof AccountChanged) throw e; // Phase 9 §0.2: this read belongs to nobody now
    // A blocked database loses the mark, not the entry: the card and the mirror row are elsewhere.
    return null;
  }
}

export async function readPending(h: AccountHandle): Promise<PendingLogEntry[]> {
  return await readPendingOrNull(h) ?? [];
}

/** False when the database refused the write: the caller decides whether that is worth a retry. */
async function writePending(h: AccountHandle, list: PendingLogEntry[]): Promise<boolean> {
  try {
    await putMeta(h, PENDING_LOG_KEY, list);
    return true;
  } catch (e) {
    if (e instanceof AccountChanged) throw e;
    console.warn("Could not record which entries are still settling.");
    return false;
  }
}

/**
 * Every read-modify-write of the list, one at a time, in two layers — the shape the parked
 * weigh-ins already use (`lib/health/weigh-in-client.ts`):
 *
 *   - `navigator.locks`, when the browser has it, holds ACROSS TABS. Two documents of this PWA
 *     share one `meta` key and no memory at all, so without it one tab's `clearPending` is
 *     overwritten by the other tab's stale snapshot (Grok pass 8, HIGH 1).
 *   - the in-heap chain, which serializes this tab's own writers and is the whole guarantee where
 *     the Web Locks API is missing (older WebKit, and Node, where the fallback is tested).
 */
const RECORDS_LOCK = "mc-pending-records";

let chain: Promise<unknown> = Promise.resolve();

function withLocalChain<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => {}).then(work);
  chain = next.catch(() => {});
  return next;
}

export function serialize<T>(work: () => Promise<T>): Promise<T> {
  // The chain still runs inside the cross-tab lock: this tab may have several writers waiting.
  // And the lock is bounded like every other one in the commit path — `markInFlight` is awaited in
  // front of the queued write and the POST, so a lock service that never answers here left the
  // meal on Today and nowhere else (panel round 11).
  return underBoundedLock(RECORDS_LOCK, () => withLocalChain(work));
}

async function mutate(
  h: AccountHandle, change: (list: PendingLogEntry[]) => PendingLogEntry[], quiet = false,
): Promise<boolean> {
  const wrote = await serialize(async () => writePending(h, bounded(change(await readPending(h)))));
  // Every record write repaints Today, except one that changes nothing Today draws.
  if (!quiet) announceLog();
  return wrote;
}

/**
 * The list, with the oldest kept requests past the cap dropped. A record that loses its request
 * has nothing left to send, so it goes `stale` in the same step: leaving it `in_flight` drew the
 * pending mark for ever and only twenty misses later admitted the truth (Grok pass 11, MEDIUM 3).
 */
function bounded(list: PendingLogEntry[]): PendingLogEntry[] {
  const withRequest = list.filter((r) => r.request !== undefined);
  if (withRequest.length <= MAX_UNCONFIRMED) return list;
  const oldest = [...withRequest]
    .sort((a, b) => Date.parse(a.markedAt) - Date.parse(b.markedAt))
    .slice(0, withRequest.length - MAX_UNCONFIRMED);
  console.warn(`Dropped ${oldest.length} unsaved log request(s) this phone could not settle.`);
  const drop = new Set(oldest.map((r) => r.entryId));
  return list.map((r) => (drop.has(r.entryId)
    ? { ...r, request: undefined, card: undefined, state: r.confirmed ? r.state : "stale" as const }
    : r));
}

/** A commit is about to post. Nothing but that commit may touch the record until it answers. */
export async function markInFlight(
  h: AccountHandle, entryId: string, userId: string | null,
  about: {
    request?: LogCommitRequest; baseRev?: number; automatic?: boolean; card?: LoggedFood;
  } = {},
): Promise<void> {
  await mutate(h, (list) => {
    const held = list.find((r) => r.entryId === entryId);
    const localDate = about.request?.local_date ?? held?.localDate;
    return [
    ...list.filter((r) => r.entryId !== entryId),
    {
      entryId,
      // Whoever the record already belonged to, unless this call knows better. A session that
      // cannot be read must not orphan a record that has an owner (Grok pass 7, MEDIUM 3).
      userId: userId ?? held?.userId ?? null,
      state: "in_flight",
      confirmed: held?.confirmed ?? false,
      baseRev: about.baseRev ?? held?.baseRev ?? 0,
      // Only while unconfirmed: once the server has the entry there is nothing to send again,
      // and nothing to draw from — Today's own copy is the card by then.
      ...(held?.confirmed ? {} : {
        request: about.request ?? held?.request, card: about.card ?? held?.card,
      }),
      // Kept whatever else goes: it is what Today reads to say where an unsettled meal is.
      ...(localDate === undefined ? {} : { localDate }),
      // No op is written yet — this record goes down BEFORE the queue write, and a kill in
      // between must leave that truth on disk (Grok pass 22, HIGH 1; Grok pass 19, note).
      ...(held?.durable === true ? {} : { durable: false }),
      // A second commit for an entry already in flight JOINS it: the bookkeeping is the record's,
      // not this call's, and resetting it would hand a live record a fresh twenty reads
      // (Grok pass 6, MEDIUM 4). A CAPPED record is the exception when the commit comes from THE USER'S
      // — a tap is new evidence the entry is there to be read (Grok pass 7, MEDIUM 3). The
      // catch-up's own re-POST is not, and it posted the same entry for ever (pass 18, HIGH 1).
      ...(!about.automatic && held?.state === "stale"
        ? { attempts: 0, nextAttemptAt: 0 }
        : { attempts: held?.attempts ?? 0, nextAttemptAt: held?.nextAttemptAt ?? 0 }),
      markedAt: new Date().toISOString(),
    },
  ];
  });
}

/** The server has the entry and this phone does not have its row. The retry owns it from here. */
export async function markNeedsReconcile(h: AccountHandle, entryId: string, userId: string | null): Promise<void> {
  await mutate(h, (list) => {
    const held = list.find((r) => r.entryId === entryId);
    // Their delete is not a read-back to retry. Turning it into one took the record that owed the
    // server the delete, and the catch-up mirrored the meal again (W027).
    if (held?.state === "deleted") return list;
    return [
      ...list.filter((r) => r.entryId !== entryId),
      {
        entryId, userId: held?.userId ?? userId, state: "needs_reconcile",
        confirmed: held?.confirmed ?? false,
        baseRev: held?.baseRev ?? 0,
        // A fact about the entry, not about its state: losing it here left the catch-up reading
        // the server about a write it never received (Grok pass 17, HIGH 2).
        ...(held?.durable === false ? { durable: false } : {}),
        ...(held?.confirmed ? {} : { request: held?.request, card: held?.card }),
        ...(held?.localDate ? { localDate: held.localDate } : {}),
        attempts: held?.attempts ?? 0, nextAttemptAt: held?.nextAttemptAt ?? 0,
        markedAt: held?.markedAt ?? new Date().toISOString(),
      },
    ];
  });
}

/**
 * The server has this entry. Said by every path that can know it: a 2xx, a drain that answered
 * `applied` or `duplicate`, and a row read back. What it changes is what the card may claim.
 */
export async function confirmEntry(h: AccountHandle, entryId: string): Promise<void> {
  await mutate(h, (list) => list.map((r) => (r.entryId === entryId
    ? { ...r, confirmed: true, request: undefined, card: undefined }
    : r)));
}

/**
 * The user deleted the entry. Everything else about the record stops mattering — the retry, the kept
 * request, the card — except whether the server has it, which is what `confirmed` still says.
 */
export async function markDeleted(
  h: AccountHandle, entryId: string, about: { userId?: string | null; confirmed?: boolean } = {},
): Promise<void> {
  await mutate(h, (list) => {
    const held = list.find((r) => r.entryId === entryId);
    return [
      ...list.filter((r) => r.entryId !== entryId),
      {
        entryId, userId: held?.userId ?? about.userId ?? null, state: "deleted",
        // A record may not exist at all — a settled commit clears it — so the caller says what it
        // knows: a mirror row with a revision is the server having the entry.
        confirmed: held?.confirmed ?? about.confirmed ?? false, baseRev: held?.baseRev ?? 0,
        ...(held?.durable === false ? { durable: false } : {}),
        ...(held?.localDate ? { localDate: held.localDate } : {}),
        attempts: held?.attempts ?? 0, nextAttemptAt: 0,
        markedAt: held?.markedAt ?? new Date().toISOString(),
      },
    ];
  });
}

/** Nothing left to send, and nothing those reads could find (Grok pass 17, HIGH 2). */
export async function markCapped(h: AccountHandle, entryId: string): Promise<void> {
  await mutate(h, (list) => list.map((r) => (r.entryId === entryId ? { ...r, state: "stale" } : r)));
}

/**
 * Whether the outbox holds this entry's write: false until the queue lands it, true after.
 *
 * Quiet — it changes nothing Today draws — and tried again once, because losing it leaves a
 * record claiming nothing was ever queued, which is a re-POST of a write the drain already has
 * (Grok pass 23, LOW 3).
 */
export async function markDurable(h: AccountHandle, entryId: string, durable: boolean): Promise<void> {
  const write = (): Promise<boolean> => mutate(h, 
    (list) => list.map((r) => (r.entryId === entryId ? { ...r, durable } : r)), true);
  if (!await write()) await write();
}

/** Is this entry one the user has deleted? Asked by every settle path before it draws or queues. */
export async function isDeleted(h: AccountHandle, entryId: string): Promise<boolean> {
  return (await readPending(h)).find((r) => r.entryId === entryId)?.state === "deleted";
}

/** One record, as it stands right now. */
export async function recordFor(h: AccountHandle, entryId: string): Promise<PendingLogEntry | undefined> {
  return (await readPending(h)).find((r) => r.entryId === entryId);
}

/** Deletes this account still owes the server. */
export async function deletedFor(h: AccountHandle, userId: string): Promise<PendingLogEntry[]> {
  return (await readPending(h)).filter((r) => r.state === "deleted"
    && r.attempts < MAX_ATTEMPTS && (r.userId === userId || r.userId === null));
}

/** Settled, refused, or given up on: there is nothing left to say about this entry. */
export async function clearPending(h: AccountHandle, entryId: string): Promise<void> {
  await mutate(h, (list) => list.filter((r) => r.entryId !== entryId));
}

/**
 * A commit's own "nothing left to do", which is never the user's delete. Clears the record unless
 * it is `deleted`, in the same serialized write that reads it, and answers whether a delete stays.
 *
 * `isDeleted` then `clearPending` is two steps, and their delete landing between them took the
 * only record that still owed the server the delete: the next pull put the meal back (W027).
 */
export async function retirePending(h: AccountHandle, entryId: string): Promise<{ deleted: boolean }> {
  let deleted = false;
  await mutate(h, (list) => list.filter((r) => {
    if (r.entryId !== entryId) return true;
    deleted = r.state === "deleted";
    return deleted;
  }));
  return { deleted };
}

/**
 * One more read spent on this record: count it, space the next one out, and stop at the cap.
 *
 * A read that found no row counts exactly like a read that failed. `maybeSingle()` answering null
 * is replica lag and a lapsed JWT as often as it is a deletion, and only a `deleted_at` row — the
 * server SAYING the entry is gone — ends the matter (Grok pass 6, HIGH 2).
 */
export async function countAttempt(h: AccountHandle, entryId: string, now: number = Date.now()): Promise<boolean> {
  let capped = false;
  await mutate(h, (list) => list.map((r) => {
    if (r.entryId !== entryId) return r;
    const attempts = r.attempts + 1;
    capped = attempts >= MAX_ATTEMPTS;
    if (capped) {
      console.warn("Gave up reading a logged entry back; it stays marked as not settled.");
      // The user's delete stays the user's delete: `stale` is a state the card has words for, and `deletedFor`
      // reads the same cap, so the asking stops either way (panel round 13).
      return r.state === "deleted" ? { ...r, attempts } : { ...r, attempts, state: "stale" as const };
    }
    const spaced = attempts > FREE_ATTEMPTS ? BACKOFF_MS * 2 ** (attempts - FREE_ATTEMPTS - 1) : 0;
    return { ...r, attempts, nextAttemptAt: now + spaced };
  }));
  return capped;
}

/** What this entry's commit was based on: every revision past it is that commit's own work. */
export async function baseRevOf(h: AccountHandle, entryId: string): Promise<number> {
  return (await readPending(h)).find((r) => r.entryId === entryId)?.baseRev ?? 0;
}

/** What to post again for an entry the user taps to retry, when the record still knows. */
export async function unsavedRequest(h: AccountHandle, entryId: string): Promise<LogCommitRequest | null> {
  const held = (await readPending(h)).find((r) => r.entryId === entryId);
  return held?.confirmed === false ? held.request ?? null : null;
}

/**
 * Is a commit posting this entry right now? Only then does anything else have to stand back.
 *
 * A record that claims to be in flight for longer than the TTL is not: the page that owned it is
 * gone, and leaving the op it queued undrainable for the life of the install would be worse than
 * the race this guards (Grok pass 6, HIGH 1).
 */
export async function isInFlight(h: AccountHandle, entryId: string): Promise<boolean> {
  const held = (await readPending(h)).find((r) => r.entryId === entryId);
  return held?.state === "in_flight";
}

/**
 * The records this account may act on: its own, plus any whose owner could not be read when they
 * were made. Another account's records are DROPPED rather than skipped — on this device they can
 * only be the previous sign-in's, and RLS would answer nothing for them anyway.
 */
export async function claimForUser(h: AccountHandle, userId: string): Promise<PendingLogEntry[]> {
  const list = await readPending(h);
  const mine = list.filter((r) => r.userId === userId || r.userId === null);
  if (mine.length !== list.length) {
    console.warn("Dropped log entries left pending by another account on this device.");
    await mutate(h, (current) => current.filter((r) => r.userId === userId || r.userId === null));
  }
  // `promoteOrphans` has already turned any abandoned `in_flight` record into one of these.
  return mine.filter((r) => r.state === "needs_reconcile");
}

/**
 * The record as it is RIGHT NOW, for the moment before it is touched. `claimForUser` hands back a
 * snapshot, and a commit can start on an entry between that read and this one (Grok pass 6,
 * MEDIUM 4).
 */
export async function readyNow(
  h: AccountHandle, entryId: string, userId: string, now: number = Date.now()
): Promise<boolean> {
  const held = (await readPending(h)).find((r) => r.entryId === entryId);
  if (held === undefined) return false;
  // A live commit owns its entry; `promoteOrphans` has already dealt with a record no commit
  // holds, so anything still `in_flight` here is one that is genuinely being posted.
  if (held.state === "stale" || held.state === "in_flight") return false;
  if (held.userId !== userId && held.userId !== null) return false;
  return held.nextAttemptAt <= now;
}
