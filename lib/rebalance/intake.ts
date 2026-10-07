/**
 * What the day has a record of (Phase 19 §5.2). Pure. Energy is known only through the one energy
 * rule's item function (`itemKcal`) and an eaten slot's projected basis (`eatenEnergyBasis`).
 * Today's display total, the legacy per-entry and per-item macro fallbacks and a frozen estimate
 * are never evidence of known intake.
 */
import { dayHasPartialNutrition } from "@/lib/resolve";
import { itemKcal } from "@/lib/nutrients/energy";
import { sumMacros } from "@/lib/plan/slot-share";
import type { PanelSlot } from "@/lib/plan/panel-slots";
import type { ResolvedDay } from "@/lib/types";

export type IntakeStatus = "complete" | "estimated" | "incomplete";

export type IntakeEvidence = {
  recordedKcal: number;
  status: IntakeStatus;
  estimatedSlots: number;
  unknownSlots: number;
  unknownItems: number;
  unknownEntries: number;
  partial: boolean;
};

const countBasis = (slots: readonly PanelSlot[], basis: PanelSlot["eatenEnergyBasis"]) =>
  slots.filter((slot) => slot.eatenEnergyBasis === basis).length;

/** Summed over every slot and logged item, rounded once. A 0 from `itemKcal` is a known zero. */
export function intakeEvidence(day: ResolvedDay, slots: readonly PanelSlot[]): IntakeEvidence {
  let raw = 0;
  for (const slot of slots) {
    // The kcal of its food lines: the same sum resolveDay gives a described slot.
    if (slot.eatenEnergyBasis === "components") raw += sumMacros(slot.components).kcal;
  }
  let unknownItems = 0;
  let unknownEntries = 0;
  for (const entry of day.extras) {
    const items = entry.items ?? [];
    if (items.length === 0) unknownEntries += 1;
    for (const item of items) {
      const kcal = itemKcal(item.snapshot ?? {});
      if (kcal === null) unknownItems += 1;
      else raw += kcal;
    }
  }
  const estimatedSlots = countBasis(slots, "estimate");
  const unknownSlots = countBasis(slots, "unknown");
  const partial = dayHasPartialNutrition(day);
  const status: IntakeStatus = unknownSlots + unknownItems + unknownEntries > 0 || partial
    ? "incomplete" : estimatedSlots > 0 ? "estimated" : "complete";
  return { recordedKcal: Math.round(raw), status, estimatedSlots, unknownSlots,
    unknownItems, unknownEntries, partial };
}
