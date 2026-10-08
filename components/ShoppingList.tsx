"use client";

import { useRef, useState, type ReactNode } from "react";
import { Plus, Share } from "lucide-react";
import Button from "@/components/ui/Button";
import Disclosure from "@/components/ui/Disclosure";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import ShoppingRow from "@/components/ShoppingRow";
import type { ShoppingLinePatch } from "@/components/ShoppingLineCard";
import { favoriteChips, listAsText, parseQuickAdd } from "@/lib/shopping/quick-add";
import type { ShoppingLine } from "@/lib/shopping/types";
import Notice from "@/components/ui/Notice";

const GROUPS: { category: ShoppingLine["category"]; title: string }[] = [
  { category: "core", title: "For your meals" },
  { category: "pantry_top_up", title: "Pantry top-ups" },
  { category: "optional_extra", title: "Optional extras" },
  { category: "manual", title: "Added by you" },
];

export type ShoppingListActions = {
  addItems: (names: string[]) => Promise<void>;
  setChecked: (line: ShoppingLine, checked: boolean) => Promise<void>;
  removeLine: (line: ShoppingLine) => Promise<void>;
  patchLine: (line: ShoppingLine, patch: ShoppingLinePatch) => Promise<void>;
  confirmPantry: (line: ShoppingLine, grams: number) => Promise<void>;
};

/**
 * The list, first (owner ask 2026-10-02: "bring back the shopping section … make it super useful").
 * Type several items at once, tap a Favorite, tick items off into the cart, clear them, and share
 * the list as text. Ticks and removals show at once and roll back if the save fails.
 */
export default function ShoppingList({ title, lines, favorites, actions, switcher, empty,
  selectedKeys, onSelectedChange, showChecks = true }: {
  title: string; lines: ShoppingLine[]; favorites: string[]; actions: ShoppingListActions;
  /** The saved-list picker, shown in the card's header. */
  switcher?: ReactNode;
  /** Shown in place of the rows when the list has no items. */
  empty?: ReactNode;
  selectedKeys?: (line: ShoppingLine) => boolean;
  onSelectedChange?: (line: ShoppingLine, selected: boolean) => void;
  /** Monthly plans tick plan items per week instead (ShoppingPurchaseWindowCard). */
  showChecks?: boolean;
}) {
  const [text, setText] = useState("");
  /** A tick shows at once and holds only while the line is still the revision it was made on: any
   *  newer read of the line (this save's answer, another device) is the truth from then on. */
  const [ticks, setTicks] = useState<Record<string, { revision: number; value: boolean; seq: number }>>({});
  const tickSeq = useRef(0);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const feedback = useActionFeedback();
  const shown = lines.filter((line) => !gone.has(line.id));
  const isChecked = (line: ShoppingLine) => {
    const tick = ticks[line.id];
    return tick && tick.revision === line.revision ? tick.value : line.checked;
  };
  const open = shown.filter((line) => !isChecked(line) || (!showChecks && line.origin === "plan"));
  const done = shown.filter((line) => isChecked(line) && (showChecks || line.origin === "manual"));
  const chips = favoriteChips(favorites, shown);
  const clearable = done.filter((line) => line.origin === "manual");

  /** `typed` is the field's text when it was sent; a chip leaves the field alone. */
  async function add(names: string[], typed?: string) {
    if (!names.length || adding) return;
    setAdding(true); setError(null);
    // The field clears as the items land, so the count is said in the notice.
    const outcome = await feedback.run(() => actions.addItems(names), { kind: "commit", confirm: "notice",
      successMessage: names.length === 1 ? `${names[0]} added.` : `${names.length} items added.`,
      failureMessage: (cause) => cause instanceof Error ? cause.message : "Those items did not save." });
    setAdding(false);
    // Only what was sent: an item typed while the add was in flight stays in the field.
    if (outcome.ok && typed !== undefined) setText((current) => current === typed ? "" : current);
  }
  async function toggle(line: ShoppingLine) {
    const next = !isChecked(line);
    const seq = ++tickSeq.current;
    setTicks((current) => ({ ...current, [line.id]: { revision: line.revision, value: next, seq } }));
    try { await actions.setChecked(line, next); }
    catch (cause) {
      // Roll back to the line as last read, and only while this is still the line's newest tick.
      setTicks((current) => {
        if (current[line.id]?.seq !== seq) return current;
        const { [line.id]: _dropped, ...rest } = current;
        return rest;
      });
      setError(cause instanceof Error ? cause.message : "That tick did not save.");
    }
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
  const row = (line: ShoppingLine) => <ShoppingRow key={line.id} line={line} checked={isChecked(line)}
    onToggle={() => void toggle(line)} busy={!showChecks && line.origin === "plan"}
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
    <form className="flex items-end gap-2" onSubmit={(event) => {
      event.preventDefault(); void add(parseQuickAdd(text, shown), text);
    }}>
      <label className="flex flex-1 flex-col gap-1 text-sm">Add items
        <input className="well min-h-11 w-full px-3" value={text} enterKeyHint="done" autoComplete="off"
          placeholder="2 avocados, eggs, oat milk" onChange={(event) => setText(event.target.value)} /></label>
      <Button type="submit" disabled={adding || parseQuickAdd(text, shown).length === 0}>Add</Button>
    </form>
    {chips.length > 0 && <div className="flex flex-col gap-1.5">
      <span className="text-tiny text-muted">From your Favorites</span>
      <div className="flex flex-wrap gap-2">{chips.map((name) => <button key={name} type="button"
        disabled={adding} onClick={() => void add([name])} aria-label={`Add ${name}`}
        className="tap well flex min-h-10 items-center gap-1 rounded-full px-3 text-caption">
        <Plus size={14} aria-hidden="true" />{name}</button>)}</div>
    </div>}
    {error && <Notice tone="error" title={error} />}
    {shown.length === 0 ? empty : <>
      {GROUPS.map(({ category, title: heading }) => {
        const group = open.filter((line) => line.category === category);
        if (!group.length) return null;
        return <section key={category} aria-label={heading} className="flex flex-col">
          <h3 className="m-0 pb-1 text-tiny font-medium uppercase tracking-wide text-muted">{heading}</h3>
          <ul className="m-0 flex list-none flex-col p-0">{group.map(row)}</ul>
        </section>;
      })}
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
