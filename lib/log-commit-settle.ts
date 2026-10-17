/**
 * What a commit's answer means for what is already on the phone: the mirror row, and the card.
 *
 * Split out of lib/log-commit-client.ts when that file passed 500 lines (Grok pass 2, MEDIUM 13);
 * no behaviour moved with it. The division is by question: that file decides what to SEND and
 * when to queue it, this one decides what to KEEP once the server has answered.
 *
 * The rule the whole file turns on: a 2xx is the server saying it has the entry, so nothing here
 * may take the card or the row away over a local failure; only a 4xx rolls anything back.
 */
import {
  AccountChanged, assertCurrent, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import type { LogCommitFailure, LogCommitRequest, LogCommitResponse } from "@/lib/log/contract";
import { isCompleteItem, serverFields } from "@/lib/log/entry-row";
import { getDay, removeExtra, updateExtra } from "@/lib/store";
import { isDeleted } from "@/lib/log/pending";
import { canPatchCard, reconcileFromServer, type ReconcileOutcome } from "@/lib/log/reconcile";
import { rowNutritionPartial } from "@/lib/log/partial-mark";
import { loadPartialRecipeRefIds } from "@/lib/recipes-client";
import { deleteOp, deleteRow, getRow, putRow } from "@/lib/sync/idb";
import { mergedItems } from "@/lib/log/card-items";
import { withItemMass, withServerAmount } from "@/lib/log/mass";
import { opIdFor } from "@/lib/log/op-id";
import type { LoggedFood } from "@/lib/types";

export { reconcileFromServer, retryPendingReconciles } from "@/lib/log/reconcile";
export type { ReconcileOutcome } from "@/lib/log/reconcile";
export { dropQueuedOps, hasQueuedOp, ownWriteQueued } from "@/lib/log/queued-ops";

/** A 2xx the client could not read. The server has the entry; the details arrive with the pull. */
export type CommitAccepted = { status: "accepted" };

/** A 4xx that named no refusal of its own. The server said no; it did not say why. */
export type CommitRefused = { status: "refused" };

/** What a settled answer can be, once the transient statuses have been queued instead. */
export type SettledResult =
  LogCommitResponse | LogCommitFailure | CommitAccepted | CommitRefused;

/** The entry to show on Today at once, and the date it belongs to. */
export type OptimisticWrite = { date: string; entry: LoggedFood };

/**
 * What the server's own answer changes about the card already on Today (T0 §3). `totals` needs
 * nothing stored: the day re-sums from the per-item snapshots, so taking those IS taking the
 * totals (lib/resolve.ts's entryMacros).
 */
export function reconcileEntry(
  entry: LoggedFood, result: LogCommitResponse
): Partial<LoggedFood> {
  const patch: Partial<LoggedFood> = {};
  // The revision the server acknowledged. A card without one reads as an entry still waiting to be
  // answered for, and a clean 2xx IS the answer — the conflict path has always taken it
  // (reconcileFromEntity), and the clean path had not (Grok pass 3, LOW 8).
  if (typeof result.rev === "number") patch.rev = result.rev;
  const flagged = Array.isArray(result.flagged) ? result.flagged : [];
  if (flagged.length > 0) {
    const names = [...new Set(flagged.map((f) => flagName(f.message)))];
    patch.flags = [...new Set([...(entry.flags ?? []), ...names])];
  }
  // #21: the answer judges the items as stored (their recorded flags), the same truth the row
  // read-back carries, so it sets the mark — and clears one only when it judged every item.
  const marks = Array.isArray(result.partial_nutrition) ? result.partial_nutrition : [];
  if (marks.length > 0) patch.nutritionPartial = true;
  // An unchecked answer judged nothing: it neither marks nor clears.
  else if (!result.nutrition_unchecked && Array.isArray(result.items) && result.items.length > 0) {
    patch.nutritionPartial = undefined;
  }
  if (entry.items && entry.items.length > 0 && Array.isArray(result.items)) {
    const byId = new Map(result.items.map((i) => [i.id, i]));
    // The server's grams and snapshot, and an unknown mass's count; the card's mass follows (t17).
    Object.assign(patch, withItemMass(entry, entry.items.map((item) => {
      const server = byId.get(item.id);
      return server ? withServerAmount(item, server) : item;
    })));
  }
  return patch;
}

/**
 * The entry as the IDB mirror sees it before the server has spoken: the request's own fields, and
 * `rev: null` for "not yet acknowledged". `captureMetaFrom` reads `method` and the items'
 * confidence off this row, which is what puts the capture glyph and the "check this" line on the
 * card. The null revision is deliberate: `lib/log-note-client.ts` and the coach's undo both take
 * their `base_rev` from this row, and an entry the server has not acknowledged has no revision to
 * base anything on — both of them already refuse a row whose `rev` is not a number.
 */
export function localRow(req: LogCommitRequest, attemptId: string): Record<string, unknown> {
  return {
    // Whose write this is. A refusal may only take back the row IT wrote: another attempt's row,
    // or one a read-back confirmed, is a meal the server has (Grok pass 9, HIGH 2).
    _attempt: attemptId,
    id: req.entry_id, eaten_at: req.eaten_at, tz: req.tz, local_date: req.local_date,
    slot: req.slot, method: req.method, note: req.note ?? null, rev: null,
    items: req.items.map((item) => ({ ...item, entry_id: req.entry_id })),
  };
}

/**
 * What the mirror held before this commit touched it. `read: false` means the question could not
 * be answered — a blocked IndexedDB — and a rollback must then leave the mirror alone rather than
 * delete a row this commit may not have created.
 */
export type MirrorBefore =
  | { read: true; previous: Record<string, unknown> | undefined; attemptId: string }
  | { read: false; attemptId: string };

/**
 * Undo the mirror write for a commit the server refused: back to what was there, or to nothing.
 *
 * Only if the row in the mirror is still the one THIS attempt wrote. Another attempt's row — or
 * one a read-back replaced it with — is the server's own, and putting the old row back over it
 * would take a meal the server has out of their log (Grok pass 9, HIGH 2). Returns whether it undid
 * anything, which is what tells the caller whether the card goes with it.
 */
export async function rollbackMirror(h: AccountHandle, entryId: string, before: MirrorBefore): Promise<boolean> {
  // Never delete a row on a guess. Not knowing what was there means leaving it as it is.
  if (!before.read) return false;
  try {
    const current = await getRow(h, "log_entries", entryId) as Record<string, unknown> | undefined;
    if (current !== undefined && current._attempt !== before.attemptId) return false;
    if (before.previous) await putRow(h, "log_entries", entryId, before.previous);
    else await deleteRow(h, "log_entries", entryId);
    return true;
  } catch (e) {
    if (e instanceof AccountChanged) return false;
    console.warn("Could not roll back the mirrored entry.");
    return false;
  }
}

/**
 * An accepted commit (any 2xx). The server has the entry, so the card and the mirror row STAY —
 * whatever the body turns out to look like. A body that is not contract-shaped costs detail, not
 * the entry: the worst case is a row that keeps the request's own items until the next pull.
 * The queued ops for this entry go, because a drain that pushed one would commit it twice.
 */
export async function settleAccepted(
  h: AccountHandle,
  req: LogCommitRequest, result: SettledResult, before: MirrorBefore, optimistic?: OptimisticWrite,
): Promise<ReconcileOutcome> {
  await dropCommitOp(h, req);
  if (result.status !== "ok") {
    console.warn("The commit was accepted but its answer was not contract-shaped.");
    // The server has the entry and the body cannot say what it holds, so the row is the only
    // place left to learn it. Reading it here is what turns "accepted" into a settled mirror
    // rather than a card over a row with no revision (Grok pass 4, HIGH 2).
    return reconcileFromServer(h, req.entry_id);
  }
  const outcome = await reconcileMirror(h, req, result, before.attemptId);
  // The card takes what the answer says about the items it already knows, by id. An item id it
  // has never heard of belongs to a food another device put there, and the next pull is what
  // brings that onto Today.
  // A tombstone has already taken the card off Today; patching it would put it back. And the card
  // on Today may have moved past this reply — another pass can settle the same entry from a newer
  // row while this commit was in the air — so the reply may only move it forward (Grok pass 6,
  // HIGH 3). `updateExtra` replaces by id, so an older patch would otherwise undo a fuller one.
  // `isDeleted` is asked HERE, not before the read above: their delete can land while that read is
  // open, and patching the card then puts the meal the user removed back on Today (pass 19, HIGH 1).
  if (optimistic && outcome !== "deleted" && !await isDeleted(h, req.entry_id)) {
    const current = getDay(optimistic.date)?.extras?.find((extra) => extra.id === req.entry_id);
    const held = typeof current?.rev === "number" ? current.rev : null;
    const incoming = typeof result.rev === "number" ? result.rev : null;
    if (canPatchCard(incoming, held, null)) {
      assertCurrent(h);
      updateExtra(optimistic.date, req.entry_id, reconcileEntry(current ?? optimistic.entry, result));
    }
  }
  return outcome;
}

/**
 * A refusal (4xx). `invalid`, `gone` and `deleted` take the local write back out rather than
 * leaving a phantom in their log (audit 2026-09-13 #6); the caller shows the reason.
 *
 * A `conflict` is not that: the entry exists, another device simply got there first. It hands
 * back the authoritative row, so the mirror takes that and the card is brought up to it instead
 * of being deleted out from under them.
 *
 * Returns whether anything was KEPT, which is the same question the sheet asks: a `conflict` whose
 * body names no entity keeps nothing, and the sheet must not answer "logged" over a card this
 * function has just removed (Grok pass 4, MEDIUM 4).
 */
export async function settleRefused(
  h: AccountHandle,
  req: LogCommitRequest, result: SettledResult, before: MirrorBefore, optimistic?: OptimisticWrite,
): Promise<boolean> {
  // A refusal is final: the server has answered and the same payload sent again would be refused
  // the same way. The op queued before the POST exists to retry a commit that has not landed, and
  // this one is never going to. Only this one: a note the user typed behind it is their write, not this
  // commit's (Grok pass 27, HIGH 2).
  await dropCommitOp(h, req);
  const entity = result.status === "conflict" && result.entity && typeof result.entity === "object"
    ? result.entity as Record<string, unknown>
    : null;
  if (entity) {
    await putRow(h, "log_entries", req.entry_id, entity).catch(rethrowAccountChanged);
    if (optimistic) {
      assertCurrent(h);
      const patch = reconcileFromEntity(optimistic.entry, entity);
      // #21: the authoritative row's recorded flags mark (or clear) the card here too.
      const partial = rowNutritionPartial(entity, await loadPartialRecipeRefIds(h));
      if (partial !== null) patch.nutritionPartial = partial || undefined;
      assertCurrent(h);
      updateExtra(optimistic.date, req.entry_id, patch);
    }
    return true;
  }
  // Asked BEFORE the rollback, which may put the previous attempt's row back and make the mirror
  // look as though someone else owns it.
  const superseded = await laterAttemptStands(h, req.entry_id, before);
  await rollbackMirror(h, req.entry_id, before);
  // The card is the caller's own write from a moment ago, so taking it back does NOT depend on
  // the rollback: `rollbackMirror` refuses to touch a mirror it could not read first, and that
  // left a meal the server refused on Today (Grok pass 15, MEDIUM 2). What keeps the card is
  // another attempt's row — that attempt is still settling, and this refusal is not its answer.
  if (optimistic && !superseded) { assertCurrent(h); removeExtra(optimistic.date, req.entry_id); }
  // Which is also the answer the sheet needs: this refusal took nothing away.
  return superseded;
}

/**
 * Is the mirror holding some OTHER attempt's row for this entry?
 *
 * Revision or not: a later attempt's row is optimistic until its own answer lands, so requiring
 * one meant this refusal took away the card that attempt is still settling (Grok pass 16,
 * MEDIUM 4). Only a row this attempt wrote, or no row at all, is this refusal's to remove.
 */
async function laterAttemptStands(h: AccountHandle, entryId: string, before: MirrorBefore): Promise<boolean> {
  try {
    const current = await getRow(h, "log_entries", entryId) as Record<string, unknown> | undefined;
    if (current === undefined) return false;
    return current._attempt !== before.attemptId;
  } catch (e) { rethrowAccountChanged(e);
    // Nothing can be proved about the mirror, and the card is still this call's own to take back.
    return false;
  }
}

/**
 * The card, brought up to an authoritative `log_entries` entity. Only the fields a server row
 * actually carries: its note, and each item's grams and snapshot. Names, portion labels and the
 * display macros are the client's own and stay put.
 */
export function reconcileFromEntity(
  entry: LoggedFood, entity: Record<string, unknown>
): Partial<LoggedFood> {
  const patch: Partial<LoggedFood> = {};
  // The revision the entity came at: a conflict is the one refusal that hands back a real one, and
  // without it the card is indistinguishable from an entry still waiting to be acknowledged
  // (panel round 7, item 4).
  if (typeof entity.rev === "number") patch.rev = entity.rev;
  const note = entity.note;
  if (typeof note === "string" || note === null) patch.note = note ?? undefined;
  const rows = Array.isArray(entity.items) ? entity.items as Record<string, unknown>[] : [];
  if (rows.length > 0) Object.assign(patch, withItemMass(entry, mergedItems(entry, rows)));
  return patch;
}

/**
 * THIS commit's own queued write, dropped the moment the server acknowledges it: the op's whole
 * purpose was to retry a commit that had not landed, and it has.
 *
 * Only its own. Another op for the same entry is another write — the note the user typed on the
 * pending card is an `update` aimed at the revision the entry had then — and dropping those with
 * it took the line the user typed out of the outbox, after which the read-back wrote the server's empty
 * note over theirs (Grok pass 27, HIGH 2). What is left drains afterwards; if the revision has moved
 * by then, `rebaseLogNote` in lib/sync/log-entry-ops.ts re-aims it at the row the server holds and
 * keeps their note on it (Grok pass 28, HIGH 1).
 */
export async function dropCommitOp(h: AccountHandle, req: LogCommitRequest): Promise<void> {
  try {
    await deleteOp(h, opIdFor(req.entry_id, req.base_rev));
  } catch (e) { rethrowAccountChanged(e); console.warn("Could not clear the queued write for a committed entry."); }
}

/**
 * The mirror row this commit already wrote, brought up to the server's own answer: `rev`, the
 * day's `totals`, any `flagged` item, and the grams and snapshot the server actually stored.
 *
 * The items come from the RESPONSE, never from the request. `ok()` in lib/server/log.ts reads
 * them back out of `log_items`, so they are the items that belong to the revision beside them; a
 * replay can return a revision newer than this request wrote, and pairing THAT with the request's
 * own items is the silent-overwrite the offline note path would then commit. When the response
 * names an item this request does not (another device changed the entry between our commit and
 * this answer) there is no honest row to build, so this returns null and the caller rolls back.
 */
type Reconciled =
  /** The answer named items: the mirror takes THEM, and the revision beside them. */
  | { kind: "row"; row: Record<string, unknown> }
  /** The answer named no items: ours stay, and no revision goes with them. */
  | { kind: "no_items" };

/**
 * The mirror row after the server has answered.
 *
 * When the reply carries items, it carries the truth: they are read back out of `log_items` by
 * `ok()` in lib/server/log.ts, and they belong to the revision printed beside them. They are
 * stored VERBATIM. Merging them with the request's own fields is what produced a row the server
 * never held — our `food_ref_id` under their `rev`, because an answer can name our item id for a
 * food another device put there — and the next offline note edit would send that back as fact
 * (panel round 7, item 3).
 *
 * When the reply carries no items it cannot vouch for ours, so ours stay exactly as written and
 * take no revision: the row waits, unacknowledged, for the authoritative read below.
 *
 * The verbatim row is thinner than a `log_entries` row — a response item has no `food_ref_id`,
 * `seq` or `unit` — which is why the authoritative read is still preferred and why
 * `lib/log-note-client.ts` refuses to base an edit on a row whose items it cannot read in full.
 */
function reconciledRow(
  req: LogCommitRequest, result: LogCommitResponse, attemptId: string,
): Reconciled {
  if (!Array.isArray(result.items) || result.items.length === 0) return { kind: "no_items" };
  // Items too thin to edit from are no better than none. `ok()` in lib/server/log.ts reads whole
  // rows back out of `log_items`, but an older deploy or a trimmed body can still answer with
  // `{id, grams, snapshot}` — and a revision stamped over those makes a row that looks editable
  // and is not, which is the refusal that rolls back a meal the server still holds. So it is
  // treated exactly like the no-items case: ours stay, no revision goes on them, and the
  // authoritative read below settles it (panel round 10, item 3).
  if (!result.items.every(isCompleteItem)) {
    console.warn("The commit's answer described its items too thinly to store.");
    return { kind: "no_items" };
  }
  // `serverFields`: this row is the acknowledged one from here on, and the attempt id is the
  // client's own bookkeeping, not a column (Grok pass 10, HIGH 2).
  return { kind: "row", row: {
    ...serverFields(localRow(req, attemptId)),
    rev: result.rev, totals: result.totals,
    flagged: Array.isArray(result.flagged) ? result.flagged : [],
    items: result.items,
  } };
}

/** The commit's own settle: what the reply said, then the row itself whenever it can be read. */
export async function reconcileMirror(
  h: AccountHandle,
  req: LogCommitRequest, result: LogCommitResponse, attemptId: string,
): Promise<ReconcileOutcome> {
  const reconciled = reconciledRow(req, result, attemptId);
  try {
    // Forward-only, like the read-back below: a pull can mirror another device's newer revision
    // while this answer is in the air, and putting this one over it hands the next note an old
    // `base_rev` — or, when that read then fails, leaves it there (W027).
    if (reconciled.kind === "row" && !await mirrorIsNewer(h, req.entry_id, result.rev)) {
      await putRow(h, "log_entries", req.entry_id, reconciled.row);
    }
    // `no_items` writes nothing: the row this commit already wrote stands, with no revision on
    // it, until the read below settles it.
  } catch (e) { rethrowAccountChanged(e); console.warn("Could not reconcile the mirrored entry."); }
  return reconcileFromServer(h, req.entry_id);
}

/** Does the mirror already hold a later revision of this entry than `rev`? A failed read says no. */
async function mirrorIsNewer(h: AccountHandle, entryId: string, rev: unknown): Promise<boolean> {
  if (typeof rev !== "number") return false;
  try {
    const held = (await getRow(h, "log_entries", entryId) as Record<string, unknown> | undefined)?.rev;
    return typeof held === "number" && held > rev;
  } catch (e) { rethrowAccountChanged(e);
    return false;
  }
}

/** "blocked:allergen:gluten" -> "gluten"; anything else keeps its own words. */
export function flagName(message: string): string {
  const parts = message.split(":");
  return parts[parts.length - 1] || message;
}

