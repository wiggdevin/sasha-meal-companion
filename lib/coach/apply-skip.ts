"use client";

/**
 * Skip a meal for one date, or bring it back, through the exact write Today's Clear uses:
 * `saveItemOverride` with `clearMeal` (app/page.tsx changeMeal), one plan_days sync op. Undo puts
 * the previous override back only while the slot still holds what this action wrote.
 */

import type { CoachAction } from "@/lib/coach/actions";
import type { SkipUndoToken } from "@/lib/coach/actions/skip-slot";
import type { ApplyResult } from "@/lib/coach/apply-shared";
import { SLOT_LABELS } from "@/lib/meals";
import { slotState } from "@/lib/plan/override-state";
import { clearMeal, isSkipped, restoreMealMarked } from "@/lib/plan/skip-override";
import { previewSkip } from "@/lib/plan/skip-preview";
import { saveItemOverride } from "@/lib/plan-day-client";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import type { SlotOverride } from "@/lib/types";

type SkipAction = Extract<CoachAction, { kind: "skip_slot" }>;
type RestoreAction = Extract<CoachAction, { kind: "restore_slot" }>;

const copy = (override: SlotOverride | undefined | null): SlotOverride | null =>
  override ? structuredClone(override) : null;

/** What the slot holds, for Undo's "has it changed since?" — shared with the server's coach Undo. */
export { slotState };

export async function applySkipSlot(action: SkipAction): Promise<ApplyResult> {
  const store = loadStore();
  const check = previewSkip(store, action.date, action.slot);
  if (!check.ok) return { status: "failed", reason: check.reason };
  // Cloned BEFORE the write: Undo must put back what was there, even if the write path mutates.
  const previous = copy(store.days[action.date]?.itemOverrides?.[action.slot]);
  const baseMealId = resolveDay(store, action.date).slots
    .find((row) => row.slot === action.slot)?.meal?.id ?? null;
  const saved = await saveItemOverride(action.date, action.slot,
    clearMeal(copy(previous) ?? undefined, baseMealId));
  return { status: "applied", token: { kind: "skip_slot", date: action.date, slot: action.slot,
    previous, applied: copy(saved.itemOverrides?.[action.slot]) } };
}

export async function applyRestoreSlot(action: RestoreAction): Promise<ApplyResult> {
  const previous = copy(loadStore().days[action.date]?.itemOverrides?.[action.slot]);
  if (!isSkipped(previous ?? undefined)) {
    return { status: "failed", reason: `${SLOT_LABELS[action.slot]} is not skipped on that date.` };
  }
  const saved = await saveItemOverride(action.date, action.slot,
    restoreMealMarked(copy(previous) ?? undefined));
  return { status: "applied", token: { kind: "restore_slot", date: action.date, slot: action.slot,
    previous, applied: copy(saved.itemOverrides?.[action.slot]) } };
}

export async function undoSkipSlot(token: SkipUndoToken<"skip_slot" | "restore_slot">): Promise<void> {
  const current = loadStore().days[token.date]?.itemOverrides?.[token.slot] ?? null;
  if (slotState(current) !== slotState(token.applied)) {
    throw new Error(`${SLOT_LABELS[token.slot]} has changed since, so Undo left it alone.`);
  }
  await saveItemOverride(token.date, token.slot, token.previous);
}
