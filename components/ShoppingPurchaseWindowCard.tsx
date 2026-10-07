"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import RuleMark from "@/components/ui/RuleMark";
import type { ShoppingLine, ShoppingPurchaseWindow } from "@/lib/shopping/types";
import { displayAmount } from "@/lib/recipes/preview-display";

export type PurchaseWindowPatch = Partial<Pick<ShoppingPurchaseWindow, "checked" | "note">>;
export default function ShoppingPurchaseWindowCard({ window, line, onPatch }: {
  window: ShoppingPurchaseWindow; line: ShoppingLine;
  onPatch: (window: ShoppingPurchaseWindow, patch: PurchaseWindowPatch) => Promise<void>;
}) {
  const [noteDraft, setNoteDraft] = useState({ base: window.note ?? "", value: window.note ?? "" });
  const note = noteDraft.base === (window.note ?? "") ? noteDraft.value : (window.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feedback = useActionFeedback();
  const boughtFeedback = useActionFeedback();
  async function patch(change: PurchaseWindowPatch) {
    setBusy(true); setError(null);
    try {
      if (change.note !== undefined) {
        // Save note confirms in itself ("Saved"); the tick below cannot speak, so it uses the notice.
        await feedback.run(() => onPatch(window, change), { kind: "commit",
          successMessage: "Week note saved.",
          failureMessage: (cause) => cause instanceof Error ? cause.message : "This week's note did not save." });
      } else {
        await boughtFeedback.run(() => onPatch(window, change), { kind: "commit", confirm: "notice",
          successMessage: change.checked ? "Marked bought this week." : "Marked not bought this week.",
          failureMessage: (cause) => cause instanceof Error ? cause.message : "This week's item did not save." });
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "This week's item did not save. Try again."); }
    finally { setBusy(false); }
  }
  // A week's line stands on the ground under its heading, so it is a card (E1), not a panel.
  return <div className="shell"><article className="surface flex flex-col gap-2 p-4">
    <div className="flex items-center justify-between gap-2"><strong>{line.name}</strong>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox"
        aria-label={`Bought ${line.name} for ${window.windowStartDate}`}
        checked={window.checked} disabled={busy}
        onChange={(event) => void patch({ checked: event.target.checked })} />Bought this week</label></div>
    <RuleMark mark={line.ruleMark} className="flex-wrap" />
    <div className="grid grid-cols-2 gap-2 text-sm">
      <div><span className="ground-muted block">Need</span>{window.needGrams === null ? "Amount unknown" : `${displayAmount(window.needGrams)} g`}</div>
      <div><span className="ground-muted block">Buy</span>{window.buyGrams === null ? "Amount unknown" : `${displayAmount(window.buyGrams)} g`}</div>
    </div>
    {window.confirmedStockGrams !== null && <p className="ground-muted m-0 text-sm">{displayAmount(window.confirmedStockGrams)} g confirmed stock allocated here.</p>}
    <div className="flex items-end gap-2"><label className="flex flex-1 flex-col gap-1 text-sm">Week note
      <input className="well min-h-11 w-full px-3" value={note}
        onChange={(event) => setNoteDraft({ base: window.note ?? "", value: event.target.value })} /></label>
      <Button disabled={busy || note === (window.note ?? "")}
        className={feedback.controlProps.className} data-feedback-state={feedback.controlProps["data-feedback-state"]}
        aria-busy={feedback.controlProps["aria-busy"]}
        confirmLabel="Saved" onClick={() => void patch({ note: note || null })}>Save note</Button></div>
    {error && <p role="alert" className="m-0 text-sm text-alert">{error}</p>}
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
    <ActionFeedbackToast notice={boughtFeedback.notice} onDismiss={boughtFeedback.dismiss} />
  </article></div>;
}
