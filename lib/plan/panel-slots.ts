/**
 * The "Rebalance my day" panel's view of a resolved day (Phase 19 §4). Pure: no store read, no
 * network. `ResolvedSlot`, `ResolvedDay` and `resolveDay` are unchanged; this projection adds the
 * two facts the panel needs and the resolved day cannot tell:
 *   - `cleared`: the date's override is an explicit Clear. `meal === null` never stands in for it
 *     (an unplanned empty slot has `meal === null` too).
 *   - `eatenEnergyBasis`: what an eaten slot's energy rests on, read from STORED state through the
 *     same helpers resolveDay uses (lib/plan/eaten-estimate.ts). Never from a meal's display
 *     name: a saved meal may carry any title, including "Eaten meal (estimate)".
 */
import {
  consumedSnapshot, eatenPlanSnapshotIfUnlogged, slotHasOwnLog, undescribedEatenSlots,
} from "@/lib/plan/eaten-estimate";
import type { ResolvedDay, ResolvedSlot, SlotId, StoredDay } from "@/lib/types";

/**
 * - `none`: not eaten.
 * - `log`: a log filed under the slot is its record; the slot contributes 0.
 * - `estimate`: an undescribed eaten slot shown at its frozen share.
 * - `components`: the eaten slot's food lines are its record.
 * - `unknown`: any other eaten slot (no share, a logged shell whose log is gone, no food lines).
 */
export type EatenEnergyBasis = "none" | "components" | "estimate" | "log" | "unknown";

export type PanelSlot = ResolvedSlot & {
  cleared: boolean;
  eatenEnergyBasis: EatenEnergyBasis;
};

/**
 * True when the STORED day holds what was eaten in this slot: an eaten recipe snapshot, a
 * time-edit snapshot resolveDay still counts (no log filed under the slot), or a saved edit with
 * food lines that is not a followPlan shell. Food lines that come only from the library or the
 * date rotation (a timestamp-only historical ritual shows a date-rotated meal) are not evidence.
 */
function storedHoldsMeal(stored: StoredDay, id: SlotId): boolean {
  const override = stored.itemOverrides?.[id];
  return consumedSnapshot(stored, id) !== undefined || eatenPlanSnapshotIfUnlogged(stored, id) !== null
    || (!!override && !override.followPlan && !override.cleared && override.components.length > 0);
}

/**
 * The basis for one resolved slot, from stored evidence only. A real frozen share is an
 * undescribed eaten slot that resolveDay shows with no food lines and a positive estimate.
 */
export function eatenEnergyBasisOf(slot: ResolvedSlot, stored: StoredDay | undefined): EatenEnergyBasis {
  const id = slot.slot;
  if (!stored?.eaten?.[id]) return "none";
  if (storedHoldsMeal(stored, id)) return "components";
  // Nothing stored describes the meal: a log filed under the slot is its record.
  if (slotHasOwnLog(stored, id)) return "log";
  const frozenShare = slot.components.length === 0 && slot.macros.kcal > 0
    && undescribedEatenSlots(stored, [id]).has(id);
  return frozenShare ? "estimate" : "unknown";
}

/** One PanelSlot per `day.slots` entry, same order. `stored` is the same date's StoredDay. */
export function projectPanelSlots(day: ResolvedDay, stored: StoredDay | undefined): PanelSlot[] {
  return day.slots.map((slot) => ({
    ...slot,
    cleared: stored?.itemOverrides?.[slot.slot]?.cleared === true,
    eatenEnergyBasis: eatenEnergyBasisOf(slot, stored),
  }));
}
