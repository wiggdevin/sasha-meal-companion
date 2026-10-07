/**
 * "Skip dinner and move its ~500 kcal into lunch and your snack?" — the numbers behind that
 * question, before anything is written. Skipping clears the slot for one date (the same override
 * Today's Clear writes, lib/today/meal-actions.ts), and the open meals share its budget
 * (lib/plan/slot-share.ts). Pure; the coach's preview_skip tool runs it on the server's store.
 */

import { SLOT_LABELS } from "@/lib/meals";
import { clearMeal, restoreMeal } from "@/lib/plan/skip-override";
import { plannedSlotIds, ratiosFor, scaledSlotTarget } from "@/lib/plan/slot-share";
import { resolveDay } from "@/lib/resolve";
import type { Macros, SlotId, Store } from "@/lib/types";

export type SkipPreviewRow = {
  slot: SlotId; label: string; time: string;
  /** open: sized from the day's share; planned: a saved meal keeps its own size. */
  state: "open" | "planned" | "eaten" | "skipped";
  kcalBefore: number; kcalAfter: number; proteinBefore: number; proteinAfter: number;
};

export type SkipPreview =
  | { ok: true; date: string; slot: SlotId; label: string; freedKcal: number;
      /** The open meals that grow; empty means nothing absorbs it and the day simply ends lower. */
      absorbedBy: string[]; rows: SkipPreviewRow[] }
  | { ok: false; date: string; slot: SlotId; reason: string };

const r = Math.round;

function withOverride(store: Store, date: string, slot: SlotId, skip: boolean): Store {
  const day = store.days[date] ?? { date };
  const previous = day.itemOverrides?.[slot];
  const baseMealId = resolveDay(store, date).slots.find((row) => row.slot === slot)?.meal?.id ?? null;
  const next = skip ? clearMeal(previous, baseMealId) : restoreMeal(previous);
  const itemOverrides = { ...(day.itemOverrides ?? {}) };
  if (next) itemOverrides[slot] = next; else delete itemOverrides[slot];
  return { ...store, days: { ...store.days, [date]: { ...day, itemOverrides } } };
}

function sizes(store: Store, date: string): Map<SlotId, { macros: Macros; state: SkipPreviewRow["state"];
  time: string }> {
  const day = resolveDay(store, date);
  const out = new Map<SlotId, { macros: Macros; state: SkipPreviewRow["state"]; time: string }>();
  for (const row of day.slots) {
    if (!row.slot.startsWith("meal-")) continue;
    const share = scaledSlotTarget(store, date, day.dayType, row.slot);
    const override = store.days[date]?.itemOverrides?.[row.slot];
    const state = row.eaten ? "eaten" : override?.cleared ? "skipped" : share ? "open" : "planned";
    out.set(row.slot, { macros: share && !row.eaten ? share : row.macros, state, time: row.time });
  }
  return out;
}

/** Whether skipping `slot` on `date` can happen, and how every meal's size changes if it does. */
export function previewSkip(store: Store, date: string, slot: SlotId): SkipPreview {
  const fail = (reason: string): SkipPreview => ({ ok: false, date, slot, reason });
  const { dayType, targets } = ratiosFor(store, date);
  if (!targets) return fail("This account has no target yet, so there is nothing to rebalance.");
  if (!slot.startsWith("meal-") || !plannedSlotIds(store, date, dayType).includes(slot)) {
    return fail(`${SLOT_LABELS[slot] ?? slot} is not on the plan that day.`);
  }
  const day = store.days[date];
  if (day?.eaten?.[slot]) return fail(`${SLOT_LABELS[slot]} is already marked eaten.`);
  if (day?.itemOverrides?.[slot]?.cleared) return fail(`${SLOT_LABELS[slot]} is already skipped.`);
  const before = sizes(store, date);
  const after = sizes(withOverride(store, date, slot, true), date);
  const rows: SkipPreviewRow[] = [...before].map(([id, was]) => {
    const now = after.get(id) ?? { macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, state: "skipped" as const };
    return { slot: id, label: SLOT_LABELS[id], time: was.time, state: id === slot ? "skipped" : now.state,
      kcalBefore: r(was.macros.kcal), kcalAfter: id === slot ? 0 : r(now.macros.kcal),
      proteinBefore: r(was.macros.protein), proteinAfter: id === slot ? 0 : r(now.macros.protein) };
  });
  return { ok: true, date, slot, label: SLOT_LABELS[slot], freedKcal: r(before.get(slot)?.macros.kcal ?? 0),
    absorbedBy: rows.filter((row) => row.state === "open" && row.kcalAfter > row.kcalBefore)
      .map((row) => row.label), rows };
}
