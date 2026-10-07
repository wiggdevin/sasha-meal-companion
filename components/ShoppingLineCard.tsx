"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import type { ShoppingLine } from "@/lib/shopping/types";
import { displayAmount } from "@/lib/recipes/preview-display";
import Disclosure from "@/components/ui/Disclosure";
import RuleMark from "@/components/ui/RuleMark";

function localDateLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  }).format(parsed);
}

function mealLabel(slot: string): string {
  return /^meal-[1-6]$/.test(slot) ? `Meal ${slot.slice(5)}`
    : slot.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export type ShoppingLinePatch = Partial<Pick<ShoppingLine, "name" | "checked" | "pinned" | "note">>;
export default function ShoppingLineCard({ line, selected = true, showBought = true,
  onSelectedChange, onPatch, onConfirmPantry }: {
  line: ShoppingLine; selected?: boolean; onSelectedChange?: (selected: boolean) => void;
  showBought?: boolean;
  onPatch?: (line: ShoppingLine, patch: ShoppingLinePatch) => Promise<void>;
  onConfirmPantry?: (line: ShoppingLine, grams: number) => Promise<void>;
}) {
  const [noteDraft, setNoteDraft] = useState({ base: line.note ?? "", value: line.note ?? "" });
  const [nameDraft, setNameDraft] = useState({ base: line.name, value: line.name });
  const initialStock = line.confirmedStockGrams?.toString() ?? "";
  const [stockDraft, setStockDraft] = useState({ base: initialStock, value: initialStock });
  const note = noteDraft.base === (line.note ?? "") ? noteDraft.value : (line.note ?? "");
  const name = nameDraft.base === line.name ? nameDraft.value : line.name;
  const stock = stockDraft.base === initialStock ? stockDraft.value : initialStock;
  const [busy, setBusy] = useState(false);
  const nameFeedback = useActionFeedback();
  const noteFeedback = useActionFeedback();
  const stateFeedback = useActionFeedback();
  /** A Save button confirms in itself ("Saved"); a tick or a pin cannot speak, so it confirms as a notice. */
  async function run(action: () => Promise<void>, feedback: ReturnType<typeof useActionFeedback>, successMessage: string,
    confirm: "control" | "notice" = "control") {
    setBusy(true);
    try { await feedback.run(action, { kind: "commit", confirm, successMessage,
      failureMessage: (cause) => cause instanceof Error ? cause.message : "Could not save this item." }); }
    finally { setBusy(false); }
  }
  return <article className="olive-panel flex flex-col gap-3 p-3">
    <div className="flex items-start justify-between gap-2">
      <div><strong className="block">{line.name}</strong>
        <span className="ground-muted text-sm">{line.origin === "manual" ? "Added by you" : line.category.replaceAll("_", " ")}</span></div>
      {showBought && <label className="flex min-h-11 min-w-11 items-center justify-center gap-2 text-sm">
        <input type="checkbox" aria-label={`Bought ${line.name}`} checked={line.checked}
          disabled={!onPatch || busy} onChange={(event) => { const checked = event.target.checked;
            void run(() => onPatch!(line, { checked }), stateFeedback,
              checked ? "Marked bought." : "Marked not bought.", "notice"); }} />
        <span className="sr-only">Bought</span>
      </label>}
    </div>
    {/* Against the account's current rules; it marks the item and never blocks an edit. */}
    <RuleMark mark={line.ruleMark} className="flex-wrap" />
    {line.origin === "manual" && <div className="flex items-end gap-2"><label className="flex flex-1 flex-col gap-1 text-sm">Item name
      <input className="well min-h-11 w-full px-3" maxLength={160} value={name}
        onChange={(event) => setNameDraft({ base: line.name, value: event.target.value })} /></label>
      <Button disabled={!onPatch || busy || !name.trim() || name.trim() === line.name}
        className={nameFeedback.controlProps.className} data-feedback-state={nameFeedback.controlProps["data-feedback-state"]}
        aria-busy={nameFeedback.controlProps["aria-busy"]}
        confirmLabel="Saved"
        onClick={() => void run(() => onPatch!(line, { name: name.trim() }), nameFeedback, "Item name saved.")}>Save name</Button></div>}
    {line.origin === "plan" && <div className="grid grid-cols-2 gap-2 text-sm">
      <div><span className="ground-muted block">Need</span>{line.needGrams === null ? "Amount unknown" : `${displayAmount(line.needGrams)} g`}</div>
      <div><span className="ground-muted block">Buy</span>{line.buyGrams === null ? "Amount unknown" : `${displayAmount(line.buyGrams)} g`}
        {line.packageGrams !== null && <span className="ground-muted block">Package {displayAmount(line.packageGrams)} g</span>}</div>
    </div>}
    {line.purchaseConversionStatus !== "known" && line.origin === "plan" && <p className="ground-muted m-0 text-sm">
      {line.purchaseConversionStatus === "unknown" ? "Purchase conversion unknown; the Buy amount is not exact." : "Purchase conversion is estimated."}
    </p>}
    {line.sources.length > 0 && <Disclosure variant="row" size="sm" bodyClassName="pb-2 text-sm"
      title={`Needed for ${line.sources.length} planned use${line.sources.length === 1 ? "" : "s"}`}>
      <ul className="m-0 list-disc pl-5">{line.sources.map((source, index) => <li key={`${source.recipeRevisionId}-${source.ingredientSeq}-${index}`}>
        {localDateLabel(source.localDate)} · {mealLabel(source.slotId)}{source.requiredGrams === null ? " · amount unknown" : ` · ${displayAmount(source.requiredGrams)} g`}</li>)}</ul>
    </Disclosure>}
    {line.identity && <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-sm">Have already (confirmed g)
        <input className="well min-h-11 w-36 px-3" type="number" min="0" step="any" value={stock}
          onChange={(event) => setStockDraft({ base: initialStock, value: event.target.value })} /></label>
      <Button disabled={!onConfirmPantry || busy || stock === "" || !Number.isFinite(Number(stock)) || Number(stock) < 0}
        onClick={() => void run(() => onConfirmPantry!(line, Number(stock)), stateFeedback, "Stock confirmed.", "notice")}>
        Confirm stock</Button>
    </div>}
    {line.identity && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox"
      checked={selected} onChange={(event) => onSelectedChange?.(event.target.checked)} />
      Use in next plan</label>}
    {line.identity && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={line.pinned}
      disabled={!onPatch || busy} onChange={(event) => { const pinned = event.target.checked;
        void run(() => onPatch!(line, { pinned }), stateFeedback,
          pinned ? "Ingredient kept in plan." : "Ingredient unpinned.", "notice"); }} />
      Keep this ingredient in my plan</label>}
    <div className="flex items-end gap-2"><label className="flex flex-1 flex-col gap-1 text-sm">Note
      <input className="well min-h-11 w-full px-3" value={note}
        onChange={(event) => setNoteDraft({ base: line.note ?? "", value: event.target.value })} /></label>
      <Button disabled={!onPatch || busy || note === (line.note ?? "")}
        className={noteFeedback.controlProps.className} data-feedback-state={noteFeedback.controlProps["data-feedback-state"]}
        aria-busy={noteFeedback.controlProps["aria-busy"]}
        confirmLabel="Saved"
        onClick={() => void run(() => onPatch!(line, { note: note || null }), noteFeedback, "Note saved.")}>Save note</Button></div>
    <ActionFeedbackToast notice={nameFeedback.notice} onDismiss={nameFeedback.dismiss} />
    <ActionFeedbackToast notice={noteFeedback.notice} onDismiss={noteFeedback.dismiss} />
    <ActionFeedbackToast notice={stateFeedback.notice} onDismiss={stateFeedback.dismiss} />
  </article>;
}
