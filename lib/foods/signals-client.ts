"use client";

/**
 * The phone's side of `POST /api/foods/signals` (Phase 18 W6). The UI lane calls `sendFoodSignals`
 * after the tap has already done its work: it never throws, never blocks, and never retries a
 * rejected event. A retry of the same events (same `clientEventId`) is stored once.
 */

import { accountFetch, accountHandle, rethrowAccountChanged, type AccountHandle } from "@/lib/device/account";
import { SIGNAL_EVENTS_MAX, type FoodSignalEvent, type SignalKind, type SignalSurface } from "./signals";

export type FoodSignalInput = {
  /** One id per showing of a slate; a swap's `swapped_away` and `picked` share it. */
  slateId: string;
  surface: SignalSurface;
  kind: SignalKind;
  occasion: FoodSignalEvent["occasion"];
  /** The food the tap was about; it must be one of `offeredKeys`. */
  chosenKey: string;
  /** Every food key the sheet or card showed, in display order, at most 8. */
  offeredKeys: readonly string[];
  /**
   * The ranking that ordered the slate, one of `SIGNAL_RANKING_VERSIONS` (lib/foods/signals.ts):
   * "o2.1" (`RANKING_VERSION`, `MealSnapshot.rankingVersion`), "swap-sheet-v1"
   * (`SWAP_SHEET_RANKING_VERSION`), "plan-sheet-v1" (`PLAN_SHEET_RANKING_VERSION`) or
   * "suggestion-card-v1" (`SUGGESTION_CARD_RANKING_VERSION`). The route counts an event with any
   * other value in `rejected` (still 202).
   */
  rankingVersion: string;
};

/** The phone's own calendar date at `now` (not the date of the plan being viewed). */
export function localDateOf(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A wire event for one tap, stamped now with a fresh client event id and the phone's local date at
 * the tap. Keep the returned object to retry it: the same `clientEventId` is stored once.
 */
export function foodSignal(input: FoodSignalInput, now: Date = new Date()): FoodSignalEvent {
  return { ...input, offeredKeys: [...input.offeredKeys], clientEventId: crypto.randomUUID(),
    at: now.toISOString(), localDate: localDateOf(now) };
}

/** Posts up to 20 events; true when the server answered 202. Never throws for a failed post. */
export async function sendFoodSignals(
  events: readonly FoodSignalEvent[],
  opts: { fetchImpl?: typeof fetch; account?: AccountHandle } = {},
): Promise<boolean> {
  if (events.length === 0) return true;
  const h = opts.account ?? accountHandle();
  let ok = true;
  for (let i = 0; i < events.length; i += SIGNAL_EVENTS_MAX) {
    try {
      const response = await accountFetch(h, "/api/foods/signals", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: events.slice(i, i + SIGNAL_EVENTS_MAX) }),
      }, { budget: "timings", fetchImpl: opts.fetchImpl });
      ok = ok && response.status === 202;
    } catch (e) {
      rethrowAccountChanged(e);
      ok = false;
    }
  }
  return ok;
}
