"use client";
/**
 * The Plan panel's one write: a `set_slot_meal` action (built by composedActions, the same path a
 * coach card uses) applied to this slot after a tap. One placement at a time, once per panel; a
 * slow save says so and keeps the panel open until it settles. Moved out of components/PlanSheet.tsx
 * so a coach card and an uploaded meal plan place through the very same code. The in-flight lock is
 * a ref set before the first await, so two calls in the same tick place once (audit 2026-10-04).
 */
import { useRef, useState } from "react";
import { ACTION_TIMEOUT_REASON, applyCoachAction } from "@/lib/coach/apply-client";
import type { CoachAction } from "@/lib/coach/actions";
import type { ApplyResult } from "@/lib/coach/apply-shared";
import { AccountChanged, assertCurrent, type AccountHandle } from "@/lib/device/account";

export function usePlaceSlot({ tz, account, onPlaced, onClose, onError }: {
  tz: string; account: () => AccountHandle | null;
  onPlaced: () => void; onClose: () => void; onError: (message: string | null) => void;
}) {
  const [placing, setPlacing] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const placed = useRef(false);
  const inFlight = useRef(false);

  async function place(action: CoachAction | null, title: string): Promise<void> {
    if (inFlight.current || placed.current || !action || action.kind !== "set_slot_meal") return;
    const h = account();
    if (!h) return;
    inFlight.current = true;
    setPlacing(true);
    onError(null);
    let settled = false;
    const finish = (result: ApplyResult) => {
      settled = true;
      inFlight.current = false;
      try { assertCurrent(h); }
      catch { onClose(); return; }
      setSavePending(false);
      setPlacing(false);
      if (result.status !== "applied") {
        onError(result.reason || "Couldn’t save this meal. Try again.");
        return;
      }
      if (placed.current) return;
      placed.current = true;
      onPlaced();
      onClose();
    };
    try {
      assertCurrent(h);
      const result = await applyCoachAction({ ...action, title: title.slice(0, 80) }, { tz, onSettled: finish });
      if (result.status === "failed" && result.reason === ACTION_TIMEOUT_REASON) {
        if (!settled) setSavePending(true);
      } else if (!settled) finish(result);
    } catch (caught) {
      inFlight.current = false;
      if (caught instanceof AccountChanged) { onClose(); return; }
      onError(caught instanceof Error && caught.message && caught.message !== "Account changed"
        ? caught.message : "Couldn’t save this meal. Try again.");
      setPlacing(false);
    }
  }

  return { placing, savePending, place };
}
