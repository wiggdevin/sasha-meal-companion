"use client";
/**
 * Today's side of lib/today/count-log-once.ts: after the Plan panel logs under a slot, the slot on
 * the day the log was FILED becomes the empty "counted in your log" meal (app/page.tsx slotLogged).
 *
 * Audit r4, two gaps closed here:
 * - The base meal, the eaten mark and the override all come from one read of the filed day as it is
 *   stored NOW (`planFor` resolves the live store). The page used its last render's `resolved` for
 *   the day on screen, which did not include the write that had just landed, and could be older
 *   still when the photo request outlived a render.
 * - One count per account, day and slot at a time (components/single-flight.ts). The failure
 *   toast's Try again, a second log's count and the first count's own retries would otherwise
 *   enqueue two override and eaten writes for one log; a second call while one is up does nothing.
 */
import { fly } from "@/components/single-flight";
import { isCurrent, type AccountHandle } from "@/lib/device/account";
import { countLogOnce } from "@/lib/today/count-log-once";
import type { SlotId, SlotOverride, StoredDay } from "@/lib/types";

type FiledPlan = { slots: { slot: string; meal?: { id: string } | null }[] };

export type CountLoggedPorts = {
  /** The filed day as stored now. */
  dayOf: (filed: string) => StoredDay | undefined;
  /** The filed day's plan, resolved from the store as it is now. */
  planFor: (filed: string) => FiledPlan;
  saveOverride: (filed: string, slotId: SlotId, override: SlotOverride) => Promise<unknown>;
  saveEaten: (filed: string, slotId: SlotId, at: string) => Promise<unknown>;
  /** The count changed the day: re-render. */
  onChanged: () => void;
  /** The count did not finish; `retry` runs it again (and is itself single-flight). */
  onFailed: (retry: () => void) => void;
};

export const countLoggedKey = (account: AccountHandle, filed: string, slotId: SlotId) =>
  `count-log:${account.userId}:${filed}:${slotId}`;

/** Null, and nothing written, while a count for this account, day and slot is already running. */
export function countLogged(account: AccountHandle, slotId: SlotId, filed: string,
  ports: CountLoggedPorts): Promise<void> | null {
  return fly(countLoggedKey(account, filed, slotId), async () => {
    if (!isCurrent(account)) return;
    const day = ports.dayOf(filed);
    const plan = ports.planFor(filed);
    const outcome = await countLogOnce({ eaten: Boolean(day?.eaten?.[slotId]), before: day?.itemOverrides?.[slotId],
      baseMealId: plan.slots.find((item) => item.slot === slotId)?.meal?.id ?? null }, {
      isCurrent: () => isCurrent(account),
      // Checked just before each call: both writers bind the account they run as at call time.
      saveOverride: (override) => ports.saveOverride(filed, slotId, override),
      saveEaten: (at) => ports.saveEaten(filed, slotId, at),
    });
    if (outcome === "stale" || !isCurrent(account)) return;
    ports.onChanged();
    if (outcome === "plan-kept" || outcome === "eaten-unsaved") {
      ports.onFailed(() => { void countLogged(account, slotId, filed, ports); });
    }
  });
}
