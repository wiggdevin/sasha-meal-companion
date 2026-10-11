/**
 * Ticking a generated meal freezes it: the slot override takes the plate's foods and stops
 * following the plan, so a later re-plan cannot rewrite a meal already eaten. Unticking must undo
 * that freeze, or the slot keeps the old plate as if the user had hand-edited it (audit A066).
 *
 * The freeze carries a `mutationId` derived from the tick's own timestamp. Every later content
 * edit writes a fresh random `mutationId` (lib/plan-day-client.ts), so on untick the id still
 * matches only while the override is exactly what the tick wrote (a time-only edit keeps it). A
 * match restores the plan; anything else is the user's edit and stays.
 */
import type { SlotId, SlotOverride } from "@/lib/types";

/** FNV-1a, 32 bits, from a chosen offset basis so four runs give four independent words. */
function fnv(text: string, basis: number): number {
  let hash = basis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const hex = (word: number) => word.toString(16).padStart(8, "0");

/** A deterministic RFC 9562 version-8 UUID for the freeze one tick writes. */
export function tickMutationId(date: string, slot: SlotId, eatenAt: string): string {
  const text = `tick:${date}:${slot}:${eatenAt}`;
  const raw = [0x811c9dc5, 0x050c5d1f, 0x2b7f3a91, 0x6a09e667].map((basis) => hex(fnv(text, basis))).join("");
  return [raw.slice(0, 8), raw.slice(8, 12), `8${raw.slice(13, 16)}`,
    `${((parseInt(raw[16]!, 16) & 0x3) | 0x8).toString(16)}${raw.slice(17, 20)}`, raw.slice(20, 32)].join("-");
}

/** The frozen override a tick writes over a followPlan (or absent) override. */
export function frozenTick(
  previous: SlotOverride | undefined,
  generated: { baseMealId: string; title: string; components: SlotOverride["components"] },
  mutationId: string,
): SlotOverride {
  const { followPlan: _followPlan, ...saved } = previous ?? { baseMealId: null, components: [] };
  void _followPlan;
  return { ...saved, baseMealId: generated.baseMealId, title: generated.title,
    components: generated.components, mutationId };
}

/**
 * What an untick leaves in the slot: `undefined` drops the override (the slot follows the plan),
 * an override keeps it. Only a generated (`suggested:`) freeze whose id matches one of the tick's
 * stamps is undone; its time and an added slot survive as a food-less followPlan shell.
 */
export function unfreezeOnUntick(
  override: SlotOverride | undefined, date: string, slot: SlotId, stamps: readonly (string | undefined)[],
): SlotOverride | undefined {
  if (!override || override.followPlan || override.cleared || override.removed
    || !override.baseMealId?.startsWith("suggested:") || !override.mutationId) return override;
  const frozen = stamps.some((stamp) => !!stamp && tickMutationId(date, slot, stamp) === override.mutationId);
  if (!frozen) return override;
  if (!override.time && !override.added) return undefined;
  return { baseMealId: null, components: [], followPlan: true,
    ...(override.time ? { time: override.time } : {}), ...(override.added ? { added: true } : {}) };
}
