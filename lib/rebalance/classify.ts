/**
 * The panel's state and highlighted cards (Phase 19 §5.3). Pure. Top to bottom, first match wins;
 * the date is checked first, so no other date reaches a state that reads its numbers. Over and
 * under are decided by `balanceOf` only.
 */
import type { SlotId } from "@/lib/types";
import { balanceOf, isIntakeKnown, type DayBalance } from "./balance";

export type PanelStateName =
  | "hidden" | "no_target" | "incomplete_intake" | "spent" | "no_action" | "over" | "under" | "on_track";

export type PanelState = { state: PanelStateName; highlights: SlotId[] };

/** Below this many minutes before the eating end, nothing is left that an action could change. */
export const NO_ACTION_WINDOW_MINUTES = 30;

const ids = (slots: readonly { slot: SlotId }[]): SlotId[] => slots.map((slot) => slot.slot);

/**
 * `today` is `targetDayFor(now)`, the device's local day. `balance` is the viewed day's
 * `dayBalance`; null when the caller has none, which reads as no target.
 */
export function classifyDay(viewedDate: string, today: string, balance: DayBalance | null): PanelState {
  if (viewedDate !== today) return { state: "hidden", highlights: [] };
  const target = balance?.targetKcal ?? null;
  if (!balance || target === null) return { state: "no_target", highlights: [] };
  const missed = ids(balance.missed);
  const remaining = ids(balance.remaining);
  if (!isIntakeKnown(balance)) return { state: "incomplete_intake", highlights: missed };
  if (balanceOf(balance.intake.recordedKcal, target) === "over") {
    return { state: "spent", highlights: remaining };
  }
  if ((missed.length === 0 && remaining.length === 0)
    || balance.windowMinutes < NO_ACTION_WINDOW_MINUTES) {
    return { state: "no_action", highlights: [] };
  }
  const planned = balanceOf(balance.planned, target);
  if (planned === "over") return { state: "over", highlights: remaining };
  if (planned === "under") return { state: "under", highlights: [...missed, ...remaining] };
  return { state: "on_track", highlights: missed };
}
