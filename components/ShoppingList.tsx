"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Share } from "lucide-react";
import Button from "@/components/ui/Button";
import Disclosure from "@/components/ui/Disclosure";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import ShoppingRow from "@/components/ShoppingRow";
import type { ShoppingLinePatch } from "@/components/ShoppingLineCard";
import { listAsText } from "@/lib/shopping/quick-add";
import type { ShoppingLine } from "@/lib/shopping/types";
import Notice from "@/components/ui/Notice";
import { aisleOf, groupByAisle } from "@/lib/foods/aisle";

export type ShoppingListActions = {
  /** Answers the saved line when it can, so a tick queued behind this one is sent on its revision. */
  setChecked: (line: ShoppingLine, checked: boolean) => Promise<ShoppingLine | void>;
  removeLine: (line: ShoppingLine) => Promise<void>;
  patchLine: (line: ShoppingLine, patch: ShoppingLinePatch) => Promise<void>;
  confirmPantry: (line: ShoppingLine, grams: number) => Promise<void>;
};

/**
 * The list (owner ask 2026-10-02: "bring back the shopping section … make it super useful"; UI
 * makeover W7 §7.1 item 3): rows grouped by store aisle, ticked off into the cart, cleared, and
 * shared as text. Adding lives in the pick list below it. Ticks and removals show at once and
 * roll back if the save fails.
 */
export default function ShoppingList({ title, lines, actions, switcher, empty,
  selectedKeys, onSelectedChange, showChecks = true, weekChecked }: {
  title: string; lines: ShoppingLine[]; actions: ShoppingListActions;
  /** The saved-list picker, shown in the card's header. */
  switcher?: ReactNode;
  /** Shown in place of the rows when the list has no items. */
  empty?: ReactNode;
  selectedKeys?: (line: ShoppingLine) => boolean;
  onSelectedChange?: (line: ShoppingLine, selected: boolean) => void;
  /** Monthly plans tick plan items per week instead (ShoppingPurchaseWindowCard). */
  showChecks?: boolean;
  /** With `showChecks` off: whether a plan line's current week is ticked (null: no weeks). */
  weekChecked?: (line: ShoppingLine) => boolean | null;
}) {
  /** A tick shows at once and holds only while the line is still the revision it was made on: any
   *  newer read of the line (this save's answer, another device) is the truth from then on. */
  const [ticks, setTicks] = useState<Record<string, { revision: number; value: boolean; seq: number; hold?: boolean }>>({});
  const tickSeq = useRef(0);
  /** One tick save in flight per line; a tap meanwhile waits here and is sent on the saved revision. */
  const inFlight = useRef(new Map<string, { queued: boolean | null }>());
  const latest = useRef(new Map<string, ShoppingLine>());
  useEffect(() => { latest.current = new Map(lines.map((line) => [line.id, line])); }, [lines]);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const feedback = useActionFeedback();
  const shown = lines.filter((line) => !gone.has(line.id));
  const isChecked = (line: ShoppingLine) => {
    const tick = ticks[line.id];
    // A held tick waits behind a save still out, so the save's own answer must not show through it.
    return tick && (tick.hold || tick.revision === line.revision) ? tick.value : line.checked;
  };
  /** A monthly list's plan items are ticked week by week, below the list. */
  const byWeek = (line: ShoppingLine) => !showChecks && line.origin === "plan" && (weekChecked?.(line) ?? null) !== null;
  const isDone = (line: ShoppingLine) => byWeek(line) ? weekChecked?.(line) === true : isChecked(line);
  const open = shown.filter((line) => !isDone(line));
  const done = shown.filter(isDone);
  const clearable = done.filter((line) => line.origin === "manual");

  async function toggle(line: ShoppingLine) {
    const next = !isChecked(line);
    const seq = ++tickSeq.current;
    setError(null);
    const pending = inFlight.current.get(line.id);
    setTicks((current) => ({ ...current, [line.id]: { revision: line.revision, value: next, seq, hold: !!pending } }));
    // A second tap while the first save is out would send the same old revision and be refused as
    // stale: it waits, and only its final value is sent once the first save answers.
    if (pending) { inFlight.current.set(line.id, { queued: next }); return; }
    await send(line, next, seq);
  }
  /** Sends the tap that waited behind a save, on the newest read of its line; false when none waits. */
  async function sendQueued(lineId: string, queued: boolean | null, base: ShoppingLine | undefined,
    sent: boolean): Promise<boolean> {
    if (queued === null || !base) return false;
    const nextSeq = ++tickSeq.current;
    if (queued === sent) {
      // Nothing more to send: the held tick becomes an ordinary one on the saved revision.
      setTicks((current) => ({ ...current, [lineId]: { revision: base.revision, value: queued, seq: nextSeq } }));
      return true;
    }
    setTicks((current) => ({ ...current, [lineId]: { revision: base.revision, value: queued, seq: nextSeq } }));
    await send(base, queued, nextSeq);
    return true;
  }
  async function send(line: ShoppingLine, value: boolean, seq: number) {
    inFlight.current.set(line.id, { queued: null });
    let saved: ShoppingLine | void;
    try { saved = await actions.setChecked(line, value); }
    catch (cause) {
      const queued = inFlight.current.get(line.id)?.queued ?? null;
      inFlight.current.delete(line.id);
      // A tap made meanwhile is the newest intent: send it against the line as last read.
      const base = latest.current.get(line.id);
      if (await sendQueued(line.id, queued, base, base?.checked ?? !queued)) return;
      // Roll back to the line as last read, and only while this is still the line's newest tick.
      setTicks((current) => {
        if (current[line.id]?.seq !== seq) return current;
        const { [line.id]: _dropped, ...rest } = current;
        return rest;
      });
      // Only the newest tick speaks: an older failure must not sit over a newer success.
      if (tickSeq.current === seq) setError(cause instanceof Error ? cause.message : "That tick did not save.");
      return;
    }
    const queued = inFlight.current.get(line.id)?.queued ?? null;
    inFlight.current.delete(line.id);
    await sendQueued(line.id, queued, saved ?? latest.current.get(line.id), value);
  }
  async function remove(targets: ShoppingLine[]) {
    setGone((current) => new Set([...current, ...targets.map((line) => line.id)]));
    const results = await Promise.allSettled(targets.map((line) => actions.removeLine(line)));
    const failed = targets.filter((_, index) => results[index].status === "rejected");
    if (failed.length) {
      setGone((current) => new Set([...current].filter((id) => !failed.some((line) => line.id === id))));
      setError(failed.length === 1 ? `${failed[0].name} was not removed. Try again.`
        : `${failed.length} items were not removed. Try again.`);
    }
  }
  async function share() {
    const body = listAsText(title, shown.map((line) => ({ ...line, checked: isChecked(line) })));
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try { await navigator.share({ title, text: body }); return; }
      catch (cause) { if ((cause as { name?: string })?.name === "AbortError") return; }
    }
    await feedback.run(() => navigator.clipboard.writeText(body), { kind: "commit", confirm: "notice",
      successMessage: "List copied.", failureMessage: () => "Could not copy the list." });
  }
  const row = (line: ShoppingLine) => <ShoppingRow key={line.id} line={line} checked={isDone(line)}
    onToggle={() => void toggle(line)} byWeek={byWeek(line)}
    onDelete={line.origin === "manual" ? () => void remove([line]) : undefined}
    onPatch={actions.patchLine} onConfirmPantry={actions.confirmPantry}
    selected={selectedKeys?.(line)} onSelectedChange={(value) => onSelectedChange?.(line, value)} />;

  return <section className="shell" aria-label="Shopping list"><div className="surface flex flex-col gap-3 p-4">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0"><h2 className="m-0 text-lg font-semibold">Your list</h2>
        <p className="m-0 text-tiny text-muted">{shown.length === 0 ? title
          : `${done.length} of ${shown.length} in cart · ${title}`}</p></div>
      {shown.length > 0 && <Button variant="icon" aria-label="Share or copy this list" onClick={() => void share()}>
        <Share size={18} aria-hidden="true" /></Button>}
    </div>
    {shown.length > 0 && <div className="pill-in h-1.5 overflow-hidden" aria-hidden="true">
      <div className="btn-primary h-full rounded-full transition-[width] duration-300"
        style={{ width: `${Math.round((done.length / shown.length) * 100)}%` }} /></div>}
    {switcher}
    {error && <Notice tone="error" title={error} />}
    {shown.length === 0 ? empty : <>
      {groupByAisle(open, (line) => aisleOf({ name: line.name, bundledId: line.identity?.foodDbId ?? null }))
        .map((group) => <section key={group.aisle} aria-label={group.label} className="flex flex-col">
          <h3 className="m-0 pb-1 text-tiny font-medium uppercase tracking-wide text-muted">{group.label}</h3>
          <ul className="m-0 flex list-none flex-col p-0">{group.items.map(row)}</ul>
        </section>)}
      {open.length === 0 && <Notice tone="success" title="Everything is in the cart." />}
      {done.length > 0 && <Disclosure variant="row" title="In cart" count={done.length}>
        <ul className="m-0 flex list-none flex-col p-0">{done.map(row)}</ul>
        {clearable.length > 0 && <Button variant="quiet" className="mt-2 self-start"
          onClick={() => void remove(clearable)}>Clear {clearable.length} bought item{clearable.length === 1 ? "" : "s"}</Button>}
      </Disclosure>}
    </>}
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
  </div></section>;
}
