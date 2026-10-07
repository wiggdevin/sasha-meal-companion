/**
 * The account's meal schedule on a `user_settings` row (`slot_times`, `shift_minutes`), in both
 * directions, so the phone and the server read one schedule (Phase 17 O4a).
 *
 *  - `scheduleFieldsFromRow`: the server's read, for every server path: the period planner
 *    (lib/server/recipe-plan.ts) and the viewed day the coach reads (lib/server/day-context.ts
 *    serverStoreFor, so `suggest_options` reads a saved 10:30 meal-1 as 10:30, not the layout's
 *    08:00; O4 review round 4, BLOCK 2).
 *  - `scheduleRowFromSettings`: the phone's write. A Settings edit of a meal time or of the
 *    whole-day shift queues these two columns (lib/sync/schedule-settings.ts, from the store's
 *    schedule-edit hook in lib/store.ts), so the server holds the clocks Today shows.
 *
 * The shift is passed through as stored, never bounded: Today applies it with `resolveSlotTimes` /
 * `shiftTime` (lib/plan.ts), which keeps each resulting time inside its own day, and the server
 * resolves its clocks with those same functions (`slotClocksFor` in lib/shopping/coverage.ts,
 * `resolveDay` behind the viewed day). A per-date time edit lives on
 * `plan_days.item_overrides[slot].time` and is applied on top by `resolveDay` and `slotClocksFor`.
 *
 * Pure. Malformed values are dropped, never guessed.
 */
import type { Settings } from "@/lib/types";

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export type ScheduleRow = { slot_times: Record<string, string>; shift_minutes: number };

/** The readable "HH:MM" slot times, keys in order, so two equal schedules compare equal. */
function clocksOf(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && CLOCK.test(entry[1]))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The whole-day shift in minutes: a finite number as stored, else 0. Never clamped. */
function shiftOf(raw: unknown): number {
  const shift = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(shift) ? shift : 0;
}

export function scheduleFieldsFromRow(row: { slot_times?: unknown; shift_minutes?: unknown } | null | undefined):
  { slotTimes: Settings["slotTimes"]; shiftMinutes: number } {
  return { slotTimes: clocksOf(row?.slot_times) as Settings["slotTimes"],
    shiftMinutes: shiftOf(row?.shift_minutes) };
}

/**
 * The two `user_settings` columns for the phone's schedule. `shift_minutes` is an integer column,
 * so a fractional shift (no control produces one) is rounded rather than failing the whole op.
 */
export function scheduleRowFromSettings(settings: Partial<Pick<Settings, "slotTimes" | "shiftMinutes">>):
  ScheduleRow {
  return { slot_times: clocksOf(settings.slotTimes), shift_minutes: Math.round(shiftOf(settings.shiftMinutes)) };
}

/** A stable signature of the schedule, for telling an edit from a save that left it alone. */
export function scheduleSignature(settings: Partial<Pick<Settings, "slotTimes" | "shiftMinutes">> | undefined): string {
  return JSON.stringify(scheduleRowFromSettings(settings ?? {}));
}
