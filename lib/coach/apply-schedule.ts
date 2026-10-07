"use client";

/** Date-scoped schedule shifts. The global Settings.shiftMinutes is never changed here. */

import type { CoachAction } from "@/lib/coach/actions";
import type { ApplyResult, UndoToken } from "@/lib/coach/apply-shared";
import { resolveSlotTimes, shiftTime } from "@/lib/plan";
import { targetDayType } from "@/lib/targets";
import { savePlanDay } from "@/lib/plan-day-client";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import type { SlotOverride } from "@/lib/types";

type ShiftAction = Extract<CoachAction, { kind: "shift_schedule" }>;
type ShiftToken = Extract<UndoToken, { kind: "shift_schedule" }>;

const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export async function applyShiftSchedule(action: ShiftAction): Promise<ApplyResult> {
  const store = loadStore();
  const stored = store.days[action.date];
  const dayType = targetDayType(action.date, stored?.dayTypeOverride, store.settings);
  const resolved = resolveDay(store, action.date);
  const slotById = new Map(resolved.slots.map((slot) => [slot.slot, slot]));
  const baseTimes = resolveSlotTimes(dayType, store.settings);
  const tokenSlots: ShiftToken["slots"] = [];
  const itemOverrides = { ...(stored?.itemOverrides ?? {}) };

  for (const { slot, time: plannedTime } of baseTimes) {
    if (action.scope === "remaining" && stored?.eaten?.[slot]) continue;
    const resolvedSlot = slotById.get(slot);
    if (!resolvedSlot?.meal) continue;
    const existing = itemOverrides[slot];
    const previous = existing?.time;
    const currentTime = previous && CLOCK_TIME.test(previous) ? previous : plannedTime;
    const override: SlotOverride = existing
      ? { ...existing, baseMealId: resolvedSlot.meal.id }
      : { baseMealId: resolvedSlot.meal.id, components: resolvedSlot.components, followPlan: true };
    override.time = shiftTime(currentTime, action.minutes);
    itemOverrides[slot] = override;
    tokenSlots.push({
      slot,
      baseMealId: resolvedSlot.meal.id,
      planned: resolvedSlot.components,
      previousTime: previous && CLOCK_TIME.test(previous) ? previous : null,
    });
  }

  await savePlanDay(action.date, { itemOverrides });

  return { status: "applied", token: {
    kind: "shift_schedule", date: action.date, slots: tokenSlots,
  } };
}

export async function undoShiftSchedule(token: ShiftToken): Promise<void> {
  const stored = loadStore().days[token.date];
  const itemOverrides = { ...(stored?.itemOverrides ?? {}) };
  for (const slot of token.slots) {
    const existing = itemOverrides[slot.slot];
    if (!existing && slot.previousTime === null) continue;
    const override: SlotOverride = existing
      ? { ...existing }
      : { baseMealId: slot.baseMealId, components: slot.planned, followPlan: true };
    if (slot.previousTime === null) delete override.time;
    else override.time = slot.previousTime;
    if (override.followPlan && override.time === undefined) delete itemOverrides[slot.slot];
    else itemOverrides[slot.slot] = override;
  }
  await savePlanDay(token.date, { itemOverrides });
}
