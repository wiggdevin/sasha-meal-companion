/**
 * What Today draws over a logged card, in three states rather than one.
 *
 * Its own module because both halves of the app write the records it reads, and because
 * lib/log-commit-client.ts is at its size limit. Nothing here posts anything.
 */
import { accountHandle, type AccountHandle } from "@/lib/device/account";
import { deferredEntryIds } from "@/lib/log/deferred-store";
import { readPending } from "@/lib/log/pending";
import { allOps } from "@/lib/sync/idb";

/** Every entry Today should draw as unfinished, in either sense. */
export async function pendingEntryIds(h: AccountHandle = accountHandle()): Promise<Set<string>> {
  const all = await logEntryStates(h);
  return new Set([...all.pending, ...all.stale, ...all.unsaved, ...all.lost]);
}

/**
 * The two states Today draws differently: still going, and given up on.
 *
 * A queued write and a commit still settling are the first — the not-synced mark, a save the user is
 * waiting on. A `stale` record is the second: the server HAS the entry and this phone has stopped
 * trying to read it back, so the card says so in words instead of looking like a save that never
 * finished and inviting a second Log (Grok pass 7, MEDIUM 4).
 */
export async function logEntryStates(h: AccountHandle = accountHandle()): Promise<LogEntryStates> {
  const ops = await allOps(h);
  const capped = await cappedIds(h);
  const stale = new Set<string>(capped.stale);
  const unsaved = new Set<string>(capped.unsaved);
  const lost = new Set<string>(capped.lost);
  const settled = (id: string): boolean => stale.has(id) || unsaved.has(id) || lost.has(id);
  const pending = new Set<string>([
    ...(await pendingIds(h)).filter((id) => !settled(id)),
    ...ops.filter((o) => o.entity === "log_entries").map((o) => o.entity_id),
    // A picked log waiting for a food ref (lib/log/picked-deferred.ts) is a save on its way too.
    ...await deferredEntryIds(h),
  ]);
  // A queued write is still going, whatever the record says about reading it back.
  for (const id of pending) { stale.delete(id); unsaved.delete(id); lost.delete(id); }
  // An entry the user deleted is in none of these. The queued delete is a write like any other and
  // would otherwise have drawn its own card as a save in progress (panel round 13).
  for (const id of await deletedIds(h)) {
    pending.delete(id); stale.delete(id); unsaved.delete(id); lost.delete(id);
  }
  return { pending, stale, unsaved, lost };
}

/**
 * Still going; the server has it but the details have not arrived; nobody ever saw it land and it
 * can be sent again; nobody ever saw it land and there is nothing left to send.
 */
export type LogEntryStates = {
  pending: Set<string>; stale: Set<string>; unsaved: Set<string>; lost: Set<string>;
};

/**
 * Every entry with a record Today has anything to draw over. `deleted` is not one of them: the
 * tombstone outlives their delete until the server has been told, and reporting it here put the
 * meal the user took off the day back on it as a save in progress (panel round 13).
 */
export async function pendingIds(h: AccountHandle): Promise<string[]> {
  return (await readPending(h)).filter((r) => r.state !== "deleted").map((r) => r.entryId);
}

/** Entries the user has deleted. Nothing about these is ever drawn, whatever else knows about them. */
export async function deletedIds(h: AccountHandle): Promise<string[]> {
  return (await readPending(h)).filter((r) => r.state === "deleted").map((r) => r.entryId);
}

/**
 * Entries whose reads have run out, in the three states the card draws differently: the server has
 * it, the server never took it and this can still be sent again, and the server never took it and
 * there is nothing left to send.
 */
export async function cappedIds(h: AccountHandle): Promise<{ stale: string[]; unsaved: string[]; lost: string[] }> {
  const capped = (await readPending(h)).filter((r) => r.state === "stale");
  const unconfirmed = capped.filter((r) => !r.confirmed);
  return {
    stale: capped.filter((r) => r.confirmed).map((r) => r.entryId),
    unsaved: unconfirmed.filter((r) => r.request !== undefined).map((r) => r.entryId),
    lost: unconfirmed.filter((r) => r.request === undefined).map((r) => r.entryId),
  };
}

/**
 * A meal still saving on a day the user is NOT looking at, if there is one.
 *
 * The catch-up redraws a recovered card on the date its request files it under. Log something
 * just before midnight and reopen the app after it, and that date is yesterday: the card lands on
 * a day the user is not on, the user sees nothing, and the user logs the meal again (Grok pass 23, MEDIUM 2).
 * Today says so in one line instead, and the line opens that day.
 *
 * Counted by entry, from both places that know a write is unfinished — the record and the outbox —
 * so one meal in both is one meal. An op speaks only through a record of theirs, because an op
 * carries no owner; the cost is that a write already handed to the outbox, whose record has gone,
 * is not announced. That one is queued, marked pending on its own day, and goes on the next sync.
 */
export async function savingElsewhere(
  viewedDate: string, h: AccountHandle = accountHandle(),
): Promise<{ date: string; count: number } | null> {
  const byDate = new Map<string, Set<string>>();
  const add = (date: unknown, entryId: string): void => {
    if (typeof date !== "string" || date === viewedDate) return;
    byDate.set(date, (byDate.get(date) ?? new Set()).add(entryId));
  };
  // Theirs, by the same rule every other reader of these records uses: their own, plus any whose
  // owner could not be read when they were made. Another account's belong to the previous
  // sign-in on this phone and the user cannot even read that day under this token (pass 24, MEDIUM 3).
  const userId = h.userId;
  const mine = (await readPending(h)).filter((r) =>
    r.state !== "deleted" && (r.userId === userId || r.userId === null));
  for (const record of mine) {
    // The record's OWN day, not the request's: a commit the server has taken keeps the record
    // until its row is read back, and `confirmEntry` has taken the request by then (pass 24).
    add(record.localDate, record.entryId);
  }
  // An op carries no owner, so it speaks only through a record of theirs — which is also what
  // keeps a leftover create for a meal the user deleted from announcing itself (MEDIUM 4).
  const owned = new Set(mine.map((r) => r.entryId));
  for (const op of await allOps(h)) {
    // A create, and nothing else. An undrained note or edit belongs to a meal that is already on
    // that day: calling it a meal still saving sends their looking for one that is not missing
    // (Grok pass 24, HIGH 2).
    if (op.entity !== "log_entries" || op.kind !== "create") continue;
    if (!owned.has(op.entity_id)) continue;
    add((op.payload as { local_date?: unknown }).local_date, op.entity_id);
  }
  // The nearest day first: the one the user has just come from is the one the user is about to look for.
  const [date, ids] = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))[0] ?? [];
  return date === undefined || ids === undefined ? null : { date, count: ids.size };
}
