/**
 * The one way a `log_entries` row is ever settled against the server: read the entry and its items
 * back, and mirror THAT — the row itself, with the revision that belongs to it.
 *
 * Every path that learns the server has the entry uses this: the commit's own 2xx, the outbox when
 * a drain reports `applied`, and the outbox when a drain reports `duplicate` (a commit whose fetch
 * timed out after the server had already applied it). None of them may stamp a revision onto the
 * request's items instead — that is a row the server never held, and an edit built from it is a
 * refusal that rolls back a meal the server still has (Grok pass 3, MEDIUM 3 and 4).
 *
 * A read that does not settle leaves the pending record behind in `needs_reconcile`, which is what
 * `retryPendingReconciles` below picks up after the next successful sync. Nothing here posts
 * anything: these entries are already the server's.
 */
import { amountLabel, entryMass } from "@/lib/log/mass";
import { assertCurrent, isCurrent, type AccountHandle } from "@/lib/device/account";
import { browserClient } from "@/lib/supabase/client";
import { withAccount } from "@/lib/device/account-supabase";
import { withinBudget } from "@/lib/fetch-with-deadline";
import { isCompleteEntryRow, serverFields } from "@/lib/log/entry-row";
import {
  baseRevOf, claimForUser, clearPending, confirmEntry, countAttempt, deletedFor, isDeleted,
  markCapped, markNeedsReconcile, readPending, readyNow, recordFor, type PendingLogEntry,
} from "@/lib/log/pending";
import { finishPendingDeletes } from "@/lib/log/delete-entry";
import { isCommitting } from "@/lib/log/live-commits";
import { getDay, removeExtra, updateExtra } from "@/lib/store";
import type { LogCommitRequest } from "@/lib/log/contract";
import type { LoggedFood } from "@/lib/types";
import { deleteRow, getRow, putRow } from "@/lib/sync/idb";
import { hasQueuedOp, ownWriteQueued, reconcileFromEntity } from "@/lib/log-commit-settle";
import { deriveMealTitle } from "@/lib/coach/meal-title";
import { loadPartialRecipeRefIds } from "@/lib/recipes-client";
import { rowNutritionPartial } from "@/lib/log/partial-mark";

/** What one read-back did about the entry. Only the first two are the end of the matter. */
export type ReconcileOutcome = "settled" | "deleted" | "missing" | "unreadable";


/** The revision the mirror already holds for this entry, when it holds one. */
async function heldRev(h: AccountHandle, entryId: string): Promise<number | null> {
  try {
    const row = await getRow(h, "log_entries", entryId);
    return typeof row?.rev === "number" ? row.rev : null;
  } catch {
    return null;
  }
}

/** The authoritative row as the mirror stores it: items coalesced the way the wire coalesces them. */
function storedRow(data: Record<string, unknown>): Record<string, unknown> {
  const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
  return {
    ...serverFields(data),
    items: items.map((item) => ({ ...serverFields(item), snapshot: item.snapshot ?? {} })),
  };
}

/**
 * Today's card, brought up to an authoritative row — when that entry is on a day the user has open.
 *
 * The generation check is the point: a row is only allowed to move a card FORWARD. A retry that
 * lands beside a newer local state, or twice with the same row, must not put an older revision's
 * numbers back on a card that has already moved past them (Grok pass 5).
 */
function patchCardFromRow(
  h: AccountHandle,
  entryId: string, row: Record<string, unknown>, mirrorRev: number | null, keepNote: boolean,
  partialRefs: ReadonlySet<string> | null = null,
): void {
  assertCurrent(h);
  const date = typeof row.local_date === "string" ? row.local_date : null;
  if (date === null) return;
  const entry = getDay(date)?.extras?.find((extra) => extra.id === entryId);
  if (!entry) return;
  if (!canPatchCard(typeof row.rev === "number" ? row.rev : null,
    typeof entry.rev === "number" ? entry.rev : null, mirrorRev)) return;
  const patch = entryPatchFromRow(entry, row);
  // A write of their own is still waiting to send this entry's note. Until it does, the note on the
  // card is theirs and the row's is simply older (Grok pass 27, HIGH 2).
  if (keepNote) delete patch.note;
  // The row is the server's word on this revision: it sets the mark and clears a stale one. Only
  // an unreadable fallback (null) leaves the card as it was.
  const partial = rowNutritionPartial(row, partialRefs);
  if (partial !== null) patch.nutritionPartial = partial || undefined;
  updateExtra(date, entryId, patch);
}

const LOGGED_SLOTS = new Set<NonNullable<LoggedFood["slot"]>>([
  "coffee", "pouches-pre", "post-refuel", "meal-1", "meal-2", "meal-3",
  "meal-4",
  "meal-5",
  "meal-6",
  "hot-chocolate", "snack",
]);

/** Display fields from the canonical row, layered over the existing card's client-only details. */
export function entryPatchFromRow(
  entry: LoggedFood, row: Record<string, unknown>,
): Partial<LoggedFood> {
  const patch = reconcileFromEntity(entry, row);
  if (typeof row.eaten_at === "string" && !Number.isNaN(Date.parse(row.eaten_at))) patch.at = row.eaten_at;
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (title) patch.name = title;
  else if (row.title === null) {
    const derived = deriveMealTitle(patch.items ?? entry.items ?? []);
    if (derived) patch.name = derived;
  }
  if (typeof row.slot === "string" && LOGGED_SLOTS.has(row.slot as NonNullable<LoggedFood["slot"]>)) {
    patch.slot = row.slot as NonNullable<LoggedFood["slot"]>;
  }
  return patch;
}

/**
 * May this row move the card? Only forward — but an EQUAL revision is not backwards. A row at the
 * revision the card already carries can still describe the entry more fully than the card does: an
 * item another device added, a snapshot the 2xx had not filled in yet (Grok pass 6, HIGH 3).
 *
 * A card with no revision of its own is judged against the MIRROR's, which knows the revision the
 * 2xx acknowledged even when the card does not.
 */
export function canPatchCard(
  incoming: number | null, held: number | null, mirrorRev: number | null,
): boolean {
  if (incoming === null) return true;
  const floor = held ?? mirrorRev;
  return floor === null || incoming >= floor;
}

/** The entry is gone on the server. Nothing local may claim otherwise, and nothing retries it. */
function forgetDeleted(h: AccountHandle, entryId: string, row: Record<string, unknown>): void {
  assertCurrent(h);
  const date = typeof row.local_date === "string" ? row.local_date : null;
  if (date !== null) removeExtra(date, entryId);
}

/** What a Supabase single-row read answers with, in the only two shapes this module reads. */
type Answer = { data: unknown; error: { message: string } | null };

export async function reconcileFromServer(
  h: AccountHandle,
  entryId: string, userId: string | null = null,
): Promise<ReconcileOutcome> {
  let row: Record<string, unknown> | null = null;
  try {
    // Bounded like every other hop the user waits on: a commit holds its entry while this read is
    // open, and a read that never answers held it past its own budget (pass 25, MEDIUM 3).
    // Phase 9 §0.5a: an answer that arrives after a switch is not this account's to act on.
    const read = withAccount(h, () => browserClient().from("log_entries")
      .select("*, items:log_items(*)").eq("id", entryId).maybeSingle()) as Promise<Answer>;
    const current = await withinBudget<Answer>(read, "commit",
      { data: null, error: { message: "no answer within the budget" } });
    assertCurrent(h);
    if (current.error) throw new Error("Could not read committed entry.");
    row = (current.data ?? null) as Record<string, unknown> | null;
  } catch (e) {
    if (!isCurrent(h)) throw e;
    console.warn("Could not read the committed entry back for offline editing.");
    await markNeedsReconcile(h, entryId, userId);
    return "unreadable";
  }
  // No row for this account: either it is not here yet, or it never will be. Either way there is
  // nothing to mirror, and `countAttempt` is what stops it being asked forever.
  if (row === null) {
    await markNeedsReconcile(h, entryId, userId);
    return "missing";
  }
  if (row.deleted_at) {
    await confirmEntry(h, entryId);
    // A tombstone is the server's last word on this entry, so the RECORD goes first: everything
    // after it is best effort, and a card or a mirror write that throws must not leave a record
    // behind for the next sync to read again (panel round 13).
    await clearPending(h, entryId);
    await deleteRow(h, "log_entries", entryId).catch(() => undefined);
    try {
      forgetDeleted(h, entryId, row);
    } catch {
      console.warn("Could not take a deleted entry off Today.");
    }
    return "deleted";
  }
  // The user deleted this entry while the read was open — in this tab or another one. Their delete is the
  // last word: nothing below may write the row back, patch the card or clear the record, because
  // the record IS what still owes the server the delete (Grok pass 19, HIGH 1).
  if (await isDeleted(h, entryId)) return "settled";
  // A row only speaks for THIS write when its revision is past the one the write was based on. A
  // lagging replica answering the previous revision is not an answer about this commit at all: it
  // may not confirm it, replace their local items, or throw away the request the user may still have to
  // send again (Grok pass 9, HIGH 4).
  const base = await baseRevOf(h, entryId);
  const rev = typeof row.rev === "number" ? row.rev : null;
  if (rev === null || rev <= base) {
    await markNeedsReconcile(h, entryId, userId);
    return "missing";
  }
  // Past the base, so it is the server's own word that it has this entry — even if the row itself
  // turns out to be too thin to store.
  await confirmEntry(h, entryId);
  const stored = storedRow(row);
  // The predicate the note path uses, asked of the authoritative row too: `log_items` can hand
  // back a null `snapshot` or `unit`, and a revision over items like those is a row that looks
  // editable and is not (Grok pass 4, MEDIUM 3).
  if (!isCompleteEntryRow(stored)) {
    console.warn("The stored entry came back incomplete.");
    await markNeedsReconcile(h, entryId, userId);
    return "unreadable";
  }
  // Forward-only, on the mirror too. A lagging replica can answer with the revision BEFORE the one
  // a 2xx just wrote, and `lib/log-note-client.ts` takes its `base_rev` from this row: storing the
  // older one sends their next note as an edit against a revision the server has moved past
  // (Grok pass 6, HIGH 3). The row already held is the better one, and the entry is settled.
  const mirrorRev = await heldRev(h, entryId);
  const incoming = typeof stored.rev === "number" ? stored.rev : null;
  if (mirrorRev !== null && incoming !== null && incoming < mirrorRev) {
    await clearPending(h, entryId);
    return "settled";
  }
  try {
    await putRow(h, "log_entries", entryId, stored);
  } catch {
    await markNeedsReconcile(h, entryId, userId);
    return "unreadable";
  }
  // The card follows the row. The row may be another device's newer one, and a card left on the
  // grams the user picked is a card a later note save would post back as fact (Grok pass 4, HIGH 2).
  patchCardFromRow(h, entryId, stored, mirrorRev, await ownWriteQueued(h, entryId),
    await loadPartialRecipeRefIds(h));
  await clearPending(h, entryId);
  return "settled";
}

/**
 * A record that says `in_flight` while no commit in this process is posting it belongs to a page
 * that is gone — killed between the write and the answer, or between a 2xx and the clear.
 *
 * Nothing would ever move it: the retry takes only `needs_reconcile`, so Today drew the pending
 * dot for good and the user logged the meal again, doubling the day (Grok pass 7, HIGH 1). So every
 * catch-up promotes them first — settled outright when the mirror already holds a row something
 * can edit, and otherwise into the queue of entries to read back, attempts intact.
 */
async function promoteOrphans(h: AccountHandle, userId: string): Promise<void> {
  for (const record of await readPending(h)) {
    if (record.state !== "in_flight") continue;
    if (record.userId !== userId && record.userId !== null) continue;
    if (await isCommitting(record.entryId)) continue;
    if (await mirrorHasThisCommit(h, record)) {
      await clearPending(h, record.entryId);
      continue;
    }
    await markNeedsReconcile(h, record.entryId, userId);
  }
}

/**
 * Is the row in the mirror THIS commit's work, or the one before it?
 *
 * A complete row is not enough: an edit's mirror write may never have happened, and the row still
 * sitting there is the previous commit's. It counts only when its revision is past the one this
 * commit was based on — and a create, which was based on nothing, counts on any revision at all
 * (Grok pass 8, MEDIUM 1).
 */
async function mirrorHasThisCommit(h: AccountHandle, record: PendingLogEntry): Promise<boolean> {
  const row = await getRow(h, "log_entries", record.entryId).catch(() => undefined);
  if (!isCompleteEntryRow(row)) return false;
  return ((row as Record<string, unknown>).rev as number) > (record.baseRev ?? 0);
}

/**
 * The catch-up a successful sync licenses: every entry the server has taken whose row is not on
 * this phone yet is read back once.
 *
 * Nothing is POSTed — their ops are already gone — and nothing `in_flight` is touched, so a commit
 * still waiting for its answer can never have its optimistic row overwritten underneath it. The
 * account is re-read between records, because a sign-in can land mid-pass.
 */
export async function retryPendingReconciles(h: AccountHandle, now: () => number = Date.now): Promise<void> {
  const userId = h.userId;
  if (!isCurrent(h)) return;
  await promoteOrphans(h, userId);
  // Deletes the server has not been told about yet: a page that died between their delete and the
  // queued delete, or a read that could not name the revision to aim it at (Grok pass 12).
  await finishPendingDeletes(h, await deletedFor(h, userId), now());
  const mine: PendingLogEntry[] = await claimForUser(h, userId);
  for (const record of mine) {
    if (!isCurrent(h)) return;
    // The claim is a snapshot: a commit can start on this entry, or another pass can settle it,
    // between that read and this one, so the record is asked again right before it is touched
    // (Grok pass 6, MEDIUM 4). It also carries the spacing — a record is not read every sync.
    if (!await readyNow(h, record.entryId, userId, now())) continue;
    const outcome = await reconcileFromServer(h, record.entryId, userId);
    if (outcome === "settled" || outcome === "deleted") continue;
    // The server does not have this row. A write nothing ever queued is then one nothing will
    // ever send, so it goes out again — but only after that read, and only on the record as it is
    // NOW (Grok pass 18, MEDIUM 2). Anything else counts a miss, `unreadable` included.
    if (outcome === "missing") {
      const unsent = await unsentRecord(h, record.entryId);
      if (unsent !== null) { await sendAgain(h, unsent, now()); continue; }
    }
    // A read that found nothing counts exactly like one that failed: only a `deleted_at` row ends
    // the matter, and the cap leaves the record marked rather than dropping it.
    await countAttempt(h, record.entryId, now());
  }
}

/**
 * The record as it is NOW, when it is one nothing has ever sent — otherwise null.
 *
 * Re-read, because the claim is a snapshot: another tab's drain, or this tab's own POST landing
 * after the client gave up on it, can confirm an entry between the claim and this moment, and
 * posting then replays a write the server has already applied (Grok pass 18, MEDIUM 2).
 *
 * TWO things must be true, and the record's own memory is the first: `durable: false` is this
 * phone saying the queue write before the POST could not be made, so nothing was ever handed to a
 * drain. Without it the entry is one of the ordinary unsettled ones — a kill mid-POST, a 2xx
 * nobody could read, a read-back that was refused — which is READ, and keeps the request behind
 * the card's "try again" (panel round 17). The outbox is the second: a later attempt may have
 * queued an op after all, and then the drain is already sending it. An outbox that cannot be read
 * at all answers neither, and this pass leaves the record alone — the next one asks again, so
 * nothing is stranded and nothing is sent twice (panel round 18; Grok pass 23, LOW 3).
 */
async function unsentRecord(h: AccountHandle, entryId: string): Promise<PendingLogEntry | null> {
  const held = await recordFor(h, entryId);
  if (held === undefined || held.confirmed || held.durable !== false) return null;
  if (held.state === "deleted") return null;
  // `false`, and nothing else: an outbox nobody can read is not an outbox with nothing in it.
  return await hasQueuedOp(h, entryId) === false ? held : null;
}

/**
 * Post it again, through the commit path — the same lock, the same join, the same settle — and
 * count the attempt, so this is bounded exactly as the reads are.
 *
 * The commit path is imported here and nowhere else in this module: it imports this one back, and
 * only a call-time import keeps that out of the module graph.
 */
async function sendAgain(h: AccountHandle, record: PendingLogEntry, now: number): Promise<void> {
  // The cap is the cap: past it the record stays `stale`, with whatever the card says about it,
  // and nothing posts it again (Grok pass 18, HIGH 1).
  if (await countAttempt(h, record.entryId, now)) return;
  if (record.request === undefined) {
    // Nothing to send and nothing to read: the card says so now rather than in twenty passes.
    await markCapped(h, record.entryId);
    return;
  }
  // With the card. A kill between the record and the paint leaves a meal nothing draws, so the
  // card is rebuilt from the request the user sent — the numbers arrive with the reply (pass 22,
  // HIGH 1) — and a card that IS there comes along so a conflict patches Today.
  const date = record.request.local_date;
  const entry = getDay(date)?.extras?.find((extra) => extra.id === record.entryId)
    ?? cardFromRequest(record.request, record.card);
  const { commitLogEntry } = await import("@/lib/log-commit-client");
  await commitLogEntry(record.request, {
    account: h, automatic: true, optimistic: { date, entry },
  }).catch(() => undefined);
}

/**
 * The last resort: a card for an entry whose own card is gone and whose record never kept one.
 *
 * What the request knows is ids, grams, units and their note — not what the user called the food. So it
 * is named the way a saved meal with no name of its own is named, and the macros are zero until
 * the reply or the read-back fills the snapshots in, which is what every card's totals come from
 * (lib/resolve.ts's entryMacros). A pending mark over a plain card is the honest state: the meal
 * is theirs, and it is still on its way.
 */
export function cardFromRequest(req: LogCommitRequest, previous?: LoggedFood): LoggedFood {
  const previousName = previous?.name.trim();
  const derived = deriveMealTitle(previous?.items ?? []);
  const count = `${req.items.length} item${req.items.length === 1 ? "" : "s"}`;
  // With no card and no record, the request still knows how many items it carries.
  const title = req.title?.trim()
    || (previousName && previousName !== "Logged meal" ? previousName : derived)
    || (previous ? "Logged meal" : `Meal · ${count}`);
  if (previous) {
    return {
      ...previous,
      id: req.entry_id,
      name: title,
      slot: req.slot,
      at: req.eaten_at,
      ...(req.note?.trim() ? { note: req.note } : {}),
    };
  }
  const { grams, massUnknown } = entryMass(req.items);
  return {
    id: req.entry_id, foodId: "meal",
    name: title, slot: req.slot,
    portionLabel: count, qty: 1, grams, ...(massUnknown ? { massUnknown: true as const } : {}),
    macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    ...(req.note ? { note: req.note } : {}),
    items: req.items.map((item, i) => ({
      id: item.id, seq: item.seq ?? i + 1, food_ref_id: item.food_ref_id, grams: item.grams,
      qty: item.qty, unit: item.unit, snapshot: {},
      foodId: "catalog:0", name: "Logged food", portionLabel: amountLabel(item),
      macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    })),
    at: req.eaten_at,
  };
}
