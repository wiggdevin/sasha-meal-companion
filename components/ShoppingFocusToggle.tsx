"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { currentAccountOrNull, isCurrent } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/foods/rules-epoch";
import { heldShoppingFocus, refreshShoppingFocus, ShoppingFocusSuperseded, undoShoppingFocusWrite,
  writeShoppingFocus } from "@/lib/shopping/focus-client";

/** The end as the person reads it: "Fri, Oct 24". Local time, since the server already chose the day. */
export function focusEndLabel(until: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" })
    .format(new Date(until));
}

/**
 * "Use my list" (Phase 18 W11, D7): when on, meal ideas favor foods already on the shopping list
 * and in the pantry. The server decides the end date; Undo restores what the write replaced and
 * says so when a later choice already stands. Rendered only inside Shopping, so it is hidden for an
 * account without Shopping access; a failed read holds no focus and shows the toggle off.
 */
export default function ShoppingFocusToggle() {
  const [until, setUntil] = useState<string | null>(() => heldShoppingFocus()?.until ?? null);
  const [busy, setBusy] = useState(false);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const h = currentAccountOrNull();
    if (!h) return;
    const sync = () => setUntil(heldShoppingFocus(h.userId)?.until ?? null);
    window.addEventListener(SYNCED_EVENT, sync);
    let live = true;
    void refreshShoppingFocus(h).then(() => { if (live && isCurrent(h)) sync(); });
    return () => { live = false; window.removeEventListener(SYNCED_EVENT, sync); };
  }, []);

  const on = until !== null;

  async function toggle() {
    const h = currentAccountOrNull();
    if (!h || busy) return;
    setBusy(true); setMessage(null); setUndoId(null);
    try {
      const answer = await writeShoppingFocus(h, !on);
      if (!isCurrent(h)) return;
      setUntil(answer.until);
      setUndoId(answer.actionId);
    } catch {
      if (isCurrent(h)) setMessage("That did not save. Try again.");
    } finally {
      if (isCurrent(h)) setBusy(false);
    }
  }

  async function undo() {
    const h = currentAccountOrNull();
    if (!h || !undoId || busy) return;
    const id = undoId;
    setBusy(true); setMessage(null);
    try {
      await undoShoppingFocusWrite(h, id);
      if (!isCurrent(h)) return;
      setUndoId(null);
      setUntil(heldShoppingFocus(h.userId)?.until ?? null);
    } catch (cause) {
      if (!isCurrent(h)) return;
      setUndoId(null);
      setUntil(heldShoppingFocus(h.userId)?.until ?? null);
      setMessage(cause instanceof ShoppingFocusSuperseded
        ? "A newer choice is already in place, so nothing was changed."
        : "That did not undo. Try again.");
    } finally {
      if (isCurrent(h)) setBusy(false);
    }
  }

  return (
    <section aria-label="Use my list" className="flex flex-col gap-2">
      <p className="m-0 text-caption text-charcoal">
        {on ? `Meal ideas favor what is on your list and in your pantry until ${focusEndLabel(until)}.`
          : "Turn on to have meal ideas favor what is on your list and in your pantry."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" role="switch" aria-label="Use my list" aria-checked={on} disabled={busy}
          onClick={() => { void toggle(); }}>
          {on ? "Stop using my list" : "Use my list"}
        </Button>
        {undoId && <Button variant="ghost" disabled={busy} onClick={() => { void undo(); }}>Undo</Button>}
      </div>
      {message && <Notice tone="attention" title={message} />}
    </section>
  );
}
