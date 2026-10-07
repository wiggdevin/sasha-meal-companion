"use client";

/**
 * The coach's taste-chip confirm card (Phase 18 W5b-2 UI): the suggested dislike and cuisine chips
 * `lib/coach/taste-chips-card.ts` attaches to a reply (`message.tasteChips`; dark on the server
 * behind `TASTE_CHIPS_ENABLED`, so this card only ever renders what the server actually sent).
 *
 * Nothing is written before the user confirms: toggling a chip only changes what this card would
 * send. Confirm posts through `lib/profile/taste-confirm-client.ts` (`confirmTasteChips`) with one
 * action id per tap (`coachConfirmRequest`). That id, and the exact picks it was sent for, are
 * stamped to storage the moment the tap is sent — before the network answers — and reused for as
 * long as the current picks match what was sent: a retry after a dropped answer (even across a
 * remount) replays the SAME id and request, which the server answers from its stored receipt rather
 * than writing again; only a changed pick (which the server would refuse as a conflict on that id)
 * starts a fresh tap. A picked set is always sent in the proposal's own declared order (`pickedOf`),
 * never a `Set`'s insertion order, so toggling a chip off and back on reorders nothing: the database
 * compares the stored request to a retry's as ordered arrays (`requested_dislikes <> p_dislikes`,
 * migration 20261220090000), so a reordered-but-equal request would otherwise read as a conflict.
 * Undo calls `undoTasteChips` with that same id, so the settings mirror comes back the same way it
 * left (lib/sync/client.ts `applyServerUserSettings`).
 *
 * A dislike only lowers a food's rank; it never excludes it. Copy here never says a chip removes or
 * takes away a food — only that it is added to, or taken off, the person's taste preferences. A
 * confirm or Undo that lands with nothing new says so plainly rather than claiming a fresh change:
 * every requested chip may already be `present`, or `capped` (the account's 50/6 limit already
 * reached) instead of newly `added`; an Undo may find its receipt already closed (`already_undone`,
 * a repeat tap) or simply holding nothing left to remove (`removed` empty on its first real call,
 * because the keys left the row some other way) — two different facts, worded differently.
 *
 * The outcome is remembered locally (account + proposal id), so a reopened conversation shows the
 * card's resting state instead of asking again — the same durable-decision pattern as
 * components/coach/RoleConfirm.tsx. `confirm`/`undo` are test (and dev-fixture) seams, same shape
 * as RoleConfirm's `confirm` prop; production callers take the defaults.
 */
import { useState } from "react";
import Button, { type ButtonStatus } from "@/components/ui/Button";
import Notice, { type NoticeTone } from "@/components/ui/Notice";
import {
  readStoredTasteChips, writeStoredTasteChips, type AppliedNoop, type UndoneNoop,
} from "@/components/coach/taste-chips-storage";
import { confirmHaptic } from "@/lib/haptics";
import { AccountChanged, currentAccountOrNull } from "@/lib/device/account";
import { coachConfirmRequest, type TasteChipsProposal } from "@/lib/coach/taste-chips-card";
import {
  confirmTasteChips, newTasteActionId, undoTasteChips, type TasteWriteOutcome,
} from "@/lib/profile/taste-confirm-client";
import type { TasteConfirmResult, TasteUndoResult } from "@/lib/profile/taste-confirm";

type Picks = { dislikes: string[]; cuisines: string[] };
type CardStatus = "idle" | "confirming" | "applied" | "undoing" | "undone";
type Message = { tone: NoticeTone; title: string };
export type ConfirmFn = typeof confirmTasteChips;
export type UndoFn = typeof undoTasteChips;

const pick = (prefix: "d" | "c", k: string) => `${prefix}:${k}`;
const unpick = (prefixed: string) => prefixed.slice(2);
const sameArray = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const samePicks = (a: Picks, b: Picks) => sameArray(a.dislikes, b.dislikes) && sameArray(a.cuisines, b.cuisines);
const count = (keys: Picks) => keys.dislikes.length + keys.cuisines.length;

export default function TasteChipsCard({ card, messageId, confirm = confirmTasteChips, undo = undoTasteChips }: {
  card: TasteChipsProposal;
  /** The assistant message this card sits under; sent back as part of the confirm request. */
  messageId: string;
  /** Test and dev-fixture seams; production callers take the real network calls. */
  confirm?: ConfirmFn;
  undo?: UndoFn;
}) {
  const account = currentAccountOrNull();
  const stored = readStoredTasteChips(account, card.id);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(stored
    ? [...stored.dislikes.map((k) => pick("d", k)), ...stored.cuisines.map((k) => pick("c", k))]
    : [...card.dislikes.map((c) => pick("d", c.key)), ...card.cuisines.map((c) => pick("c", c.key))]));
  const [pendingActionId, setPendingActionId] = useState<string | null>(stored?.actionId ?? null);
  /** The exact picks `pendingActionId` was last sent for; null once nothing is in flight or queued. */
  const [attempted, setAttempted] = useState<Picks | null>(
    stored && stored.status === "pending" ? { dislikes: stored.dislikes, cuisines: stored.cuisines } : null);
  const [status, setStatus] = useState<CardStatus>(
    stored?.status === "applied" ? "applied" : stored?.status === "undone" ? "undone" : "idle");
  const [buttonStatus, setButtonStatus] = useState<ButtonStatus>("idle");
  const [message, setMessage] = useState<Message | null>(null);
  const [appliedKeys, setAppliedKeys] = useState<Picks>(
    stored && stored.status !== "pending" ? { dislikes: stored.dislikes, cuisines: stored.cuisines }
      : { dislikes: [], cuisines: [] });
  const [noop, setNoop] = useState<AppliedNoop | UndoneNoop | false>(stored?.noop ?? false);

  function toggle(prefixed: string) {
    if (status !== "idle") return;
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(prefixed)) next.delete(prefixed); else next.add(prefixed);
      return next;
    });
    setMessage(null);
  }

  /** The current picks for one kind, in the proposal's own order — never a `Set`'s insertion order,
   *  so the exact same final selection always sends the exact same array regardless of toggle path. */
  function pickedOf(prefix: "d" | "c"): string[] {
    const offered = prefix === "d" ? card.dislikes : card.cuisines;
    return offered.filter((c) => picked.has(pick(prefix, c.key))).map((c) => c.key);
  }

  async function onConfirm() {
    if (status !== "idle" || !account) return;
    const picks: Picks = { dislikes: pickedOf("d"), cuisines: pickedOf("c") };
    if (count(picks) === 0) return;
    // Reuse the queued id only while it still names exactly these picks; a changed selection is a
    // fresh tap (the server treats the same id with a different request as a conflict, not a retry).
    const reusing = pendingActionId !== null && attempted !== null && samePicks(attempted, picks);
    const actionId = reusing ? pendingActionId! : newTasteActionId();
    const request = coachConfirmRequest(card, messageId, picks, actionId);
    if (!request) {
      setMessage({ tone: "error", title: "That pick is no longer offered here." });
      return;
    }
    setPendingActionId(actionId);
    setAttempted(picks);
    // Stamped before the network answers: a dropped response still leaves the next tap (even after
    // a remount) able to replay this exact id and request rather than mint a new one.
    writeStoredTasteChips(account, card.id, { actionId, dislikes: picks.dislikes, cuisines: picks.cuisines, status: "pending" });
    setStatus("confirming");
    setButtonStatus("pending");
    setMessage(null);
    let outcome: TasteWriteOutcome<TasteConfirmResult>;
    try {
      outcome = await confirm(request, { account });
    } catch (error) {
      if (error instanceof AccountChanged) return;
      outcome = { ok: false, reason: "retry", message: "Could not save. Try again." };
    }
    if (!outcome.ok) {
      setStatus("idle");
      setButtonStatus("idle");
      setMessage(outcome.reason === "offline"
        ? { tone: "attention", title: "No connection. Tap Add again once you're back online." }
        : { tone: "error", title: outcome.message });
      return;
    }
    // A replayed confirm (the lost-answer retry this id exists for) can land after the receipt was
    // already closed — by this card's own Undo, another tap, or another device — between the first
    // send and this one landing. `undoneAt` says so; showing "Added" with a live Undo over a closed
    // receipt would be wrong, so the honest resting state wins over a fresh "applied". But `added`
    // empty means this action never wrote anything new (every pick was already `present`, or
    // `capped`) — there was nothing of this action's for an Undo to have removed, so "already
    // undone" would overclaim; "gone" reuses the same honest "Nothing to undo" title onUndo shows
    // for the equivalent case, with its own wording below (verified finding).
    if (outcome.result.undoneAt !== null) {
      const addedSomething = count(outcome.result.added) > 0;
      const closedKeys = addedSomething ? outcome.result.added : outcome.result.present;
      const closedNoop: UndoneNoop = addedSomething ? "repeat" : "gone";
      setAppliedKeys(closedKeys);
      setButtonStatus("idle");
      setStatus("undone");
      setNoop(closedNoop);
      writeStoredTasteChips(account, card.id, { actionId, dislikes: closedKeys.dislikes, cuisines: closedKeys.cuisines,
        status: "undone", noop: closedNoop });
      setMessage({ tone: "attention", title: addedSomething
        ? "This was already undone."
        // Unlike onUndo's own "gone" (keys left the row some OTHER way, e.g. a Settings edit),
        // this is simply an action that never added anything in the first place -- every pick was
        // already present, capped, or both -- so "already changed" would overclaim here too
        // (Sol r5 WARN, verified).
        : "Nothing was added, so there was nothing to undo." });
      return;
    }
    confirmHaptic();
    setButtonStatus("success");
    setStatus("applied");
    // `added`: exactly what this tap wrote (and what its Undo may remove). Empty means nothing was
    // newly written — every pick was already `present`, or `capped` at the account's 50/6 limit —
    // a real outcome, never dressed up as a fresh addition.
    const addedNothing = count(outcome.result.added) === 0;
    const appliedNoop: AppliedNoop | false = !addedNothing ? false
      : count(outcome.result.capped) === 0 ? "present"
      : count(outcome.result.present) === 0 ? "capped" : "mixed";
    setAppliedKeys(addedNothing ? { dislikes: [], cuisines: [] } : outcome.result.added);
    setNoop(appliedNoop);
    writeStoredTasteChips(account, card.id, { actionId, dislikes: outcome.result.added.dislikes,
      cuisines: outcome.result.added.cuisines, status: "applied", ...(appliedNoop ? { noop: appliedNoop } : {}) });
  }

  async function onUndo() {
    if (status !== "applied" || noop || !pendingActionId || !account) return;
    setStatus("undoing");
    setMessage(null);
    let outcome: TasteWriteOutcome<TasteUndoResult>;
    try {
      outcome = await undo(pendingActionId, { account });
    } catch (error) {
      if (error instanceof AccountChanged) return;
      outcome = { ok: false, reason: "retry", message: "Could not undo. Try again." };
    }
    if (!outcome.ok) {
      setStatus("applied");
      setMessage(outcome.reason === "offline"
        ? { tone: "attention", title: "No connection. Try again once you're back online." }
        : { tone: "error", title: outcome.message });
      return;
    }
    // "already gone" honestly, and told apart: `already_undone` means an earlier tap (here or on
    // another device) already ran this Undo — and the RPC repeats that FIRST call's (nonempty)
    // `removed` keys on the repeat, so `status` must be checked before `removed`'s own count, not
    // after. `removed` empty on a genuine first call means the keys left the row some other way
    // (e.g. a direct Settings edit) before this Undo ever ran. Neither is shown as a fresh Undo, but
    // they are not the same claim.
    const undoneNoop: UndoneNoop | false = outcome.result.status === "already_undone" ? "repeat"
      : count(outcome.result.removed) === 0 ? "gone" : false;
    setStatus("undone");
    setNoop(undoneNoop);
    writeStoredTasteChips(account, card.id, { actionId: pendingActionId, dislikes: appliedKeys.dislikes,
      cuisines: appliedKeys.cuisines, status: "undone", ...(undoneNoop ? { noop: undoneNoop } : {}) });
    if (undoneNoop === "repeat") {
      setMessage({ tone: "attention", title: "This was already undone." });
    } else if (undoneNoop === "gone") {
      setMessage({ tone: "attention", title: "Those had already changed in your settings, so Undo made no change." });
    } else if (count(outcome.result.gone) > 0) {
      setMessage({ tone: "attention", title: "Some of these had already changed in your settings, so Undo left them." });
    }
  }

  const chips = [
    ...card.dislikes.map((c) => ({ prefixed: pick("d", c.key), label: c.label })),
    ...card.cuisines.map((c) => ({ prefixed: pick("c", c.key), label: c.label })),
  ];
  const selectable = status === "idle";
  const nothingPicked = picked.size === 0;

  const title = status === "applied" ? (
    noop === "present" ? "Already in your taste preferences"
      : noop === "capped" ? "Could not add — your taste preferences are full"
      : noop === "mixed" ? "Some were already saved; others couldn't fit"
      : "Added to your taste preferences")
    : status === "undone" ? (
      noop === "repeat" ? "Already undone"
        : noop === "gone" ? "Nothing to undo"
        : "Removed from your taste preferences")
    : "Want these in your taste preferences?";

  return <section aria-label="Suggested taste preferences" className="shell mx-3">
    <div className="surface flex flex-col gap-3 rounded-2xl p-4">
      <h3 className="m-0 text-caption font-medium text-charcoal">{title}</h3>
      {status === "idle" && <p className="m-0 text-tiny text-muted">
        A dislike only means less of it in your plans — it never takes a food off the table.
      </p>}
      <div className="flex flex-wrap gap-2">
        {chips.map(({ prefixed, label }) => {
          const active = status === "idle" ? picked.has(prefixed) : appliedKeys.dislikes.includes(unpick(prefixed))
            || appliedKeys.cuisines.includes(unpick(prefixed));
          if (status !== "idle" && !active) return null;
          return <Button key={prefixed} type="button" variant={active ? "primary" : "tertiary"} size="sm"
            aria-pressed={active} disabled={!selectable} onClick={() => toggle(prefixed)}>
            {label}
          </Button>;
        })}
      </div>
      {message && <Notice tone={message.tone} title={message.title} onDismiss={() => setMessage(null)} />}
      {status === "idle" && <div className="self-start">
        <Button variant="primary" size="sm" status={buttonStatus} confirmLabel="Added"
          disabled={nothingPicked} onClick={() => { void onConfirm(); }}>
          Add to my taste preferences
        </Button>
      </div>}
      {!noop && (status === "applied" || status === "undoing") && <div className="self-start">
        <Button variant="tertiary" size="sm" onClick={() => { void onUndo(); }} disabled={status === "undoing"}>
          {status === "undoing" ? "Undoing…" : "Undo"}
        </Button>
      </div>}
    </div>
  </section>;
}
