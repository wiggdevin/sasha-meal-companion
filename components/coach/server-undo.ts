import type { CoachAction } from "@/lib/coach/actions";
import type { ChatAction, ChatMessage } from "@/lib/coach/chat-state";
import type { CoachUndoView } from "@/lib/coach/undo-client";
import { readStoredTasteChips } from "@/components/coach/taste-chips-storage";
import type { AccountHandle } from "@/lib/device/account";

/**
 * Server-recorded coach Undo on the transcript (C4, lib/coach/undo-types.ts). This phone's own
 * ledger holds the actions it applied, with their tokens, and draws them as it always has. Every
 * other record the server holds joins the transcript as a server-held entry with no token, drawn
 * from the record's own `card` (docs/specs/coach-undo-receipt.md §6.5): a receipt card's title and
 * foods, or the generic "Coach change" card for every legacy record. Nothing is inferred from a
 * saved coach message, so a composed card's tap (whose action no message carries) still shows on
 * another device, and an issued action shows what the server knows, not what the message said.
 * Its Undo goes to the server (`undoCoachAction(id, null)`), which decides.
 *
 * One exception: a `confirm_taste_chips` record's own message already renders its own inline
 * `TasteChipsCard` (CoachChat's `renderExtras`, keyed off `message.tasteChips`) — that card reads
 * and writes this action's state directly (confirm/Undo, its own resting status). WHEN this
 * device's copy of that card already shows a resting `applied`/`undone` state for THIS SAME
 * action id (its own local storage, read the same way the card itself does), a second,
 * separately-sourced generic card for the same action here would only duplicate it and drift out
 * of sync the moment either is acted on (Sol r3 BLOCK: "inline vs Undo-list state not synced") —
 * so that record is left out. On a device with NO local resolution yet (a fresh install, cleared
 * storage, or a second device that never tapped Add here), the inline card has nothing to show
 * and offers no Undo of its own — so this record is kept, exactly as any other server-held record
 * is, to stay the record's only reachable Undo path on that device (Sol r4 BLOCK on the first cut
 * of this fix, which skipped unconditionally and silently dropped that Undo path — verified).
 */

/** A server-held entry's own Undo progress, kept beside the reducer (which needs a token).
 *  `already` (t23 #8): this tap found the action already undone, rather than undoing it fresh. */
export type ServerUndoProgress =
  Record<string, { status: "undoing" | "undone" | "failed"; reason?: string; already?: true }>;

/** An action the server can still undo now. */
export function serverCanUndo(record: CoachUndoView | undefined): boolean {
  return !!record && record.serverUndoable && !record.expired && record.undoneAt === null;
}

/**
 * The message a server-held card sits under. A receipt card names its source message only when the
 * receipt's source check matched (§6.5); a generic card sits under the message its record was made
 * from. Null: under no message (the end of the transcript).
 */
export function placementOf(record: CoachUndoView): string | null {
  return record.card.type === "receipt" ? record.card.messageId : record.messageId;
}

/** Only what Undo and the card's key need: the record's own id and kind, never a message's action. */
function recordAction(record: CoachUndoView): CoachAction {
  return { kind: record.kind, actionId: record.actionId, flagged: [] } as unknown as CoachAction;
}

/**
 * This device's own inline `TasteChipsCard` for `message` already shows a resting state FOR
 * `actionId` specifically, so a server-held duplicate of that exact action would only repeat it.
 * `message.tasteChips` is read from `CoachMessageView` (lib/coach/message-view.ts) through the
 * same kind of cast CoachChat.tsx already uses for it — `ChatMessage` itself (this module's own
 * `messages` type) stays the narrow shape the rest of the transcript needs, rather than widening
 * it for one field.
 *
 * The stored entry's OWN `actionId` must match `record.actionId`, not just its proposal id: the
 * same proposal can be confirmed more than once over time with a different action id each time
 * (a fresh tap after an Undo, or on another device) — matching on proposal id alone would read an
 * older, unrelated action's resting state as if it covered a newer one on the same proposal and
 * hide ITS server card too, with no Undo path left for it (Sol r5 BLOCK, verified).
 */
function locallyResolvedTasteMessage(
  account: AccountHandle | null, message: ChatMessage | undefined, actionId: string,
): boolean {
  const proposalId = (message as { tasteChips?: { id?: unknown } } | undefined)?.tasteChips?.id;
  if (typeof proposalId !== "string") return false;
  const stored = readStoredTasteChips(account, proposalId);
  return stored !== null && stored.status !== "pending" && stored.actionId === actionId;
}

/**
 * The transcript's action cards: this phone's ledger, marked undone where another device undid it,
 * plus one server-held card for each record this phone does not hold, once each, oldest first. A
 * record whose message is not loaded yet waits for that message (an older page).
 */
export function withServerUndos(
  messages: readonly ChatMessage[], actions: readonly ChatAction[],
  records: readonly CoachUndoView[], progress: ServerUndoProgress, account: AccountHandle | null = null,
): ChatAction[] {
  if (records.length === 0) return [...actions];
  const byAction = new Map(records.map((record) => [record.actionId, record]));
  const shown = new Set(actions.map((entry) => entry.action.actionId));
  const merged = actions.map((entry): ChatAction => {
    // The server's tombstone wins: an Undo that timed out here, or ran on another device, is done.
    if (entry.status === "pending" || entry.status === "undone"
      || !byAction.get(entry.action.actionId)?.undoneAt) return entry;
    const { token: _token, reason: _reason, ...rest } = entry;
    return { ...rest, status: "undone" };
  });
  const loaded = new Map(messages.map((message) => [message.id, message]));
  const oldestFirst = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const record of oldestFirst) {
    if (shown.has(record.actionId)) continue;
    const messageId = placementOf(record);
    const message = messageId === null ? undefined : loaded.get(messageId);
    if (messageId !== null && !message) continue;
    // See the module docblock: skip only once this device's OWN inline card already rests on
    // applied/undone for it -- never for a device with nothing local yet, which needs this as
    // its only Undo path.
    if (record.card.type === "taste" && locallyResolvedTasteMessage(account, message, record.actionId)) continue;
    shown.add(record.actionId);
    const own = progress[record.actionId];
    merged.push({
      action: recordAction(record), messageId,
      server: { card: record.card, createdAt: record.createdAt },
      status: own?.status ?? (record.undoneAt ? "undone" : "applied"),
      ...(own?.reason ? { reason: own.reason } : {}),
      ...(own?.already ? { already: true } : {}),
      ...(serverCanUndo(record) && own?.status !== "undone" ? { serverUndoable: true } : {}),
    });
  }
  return merged;
}
