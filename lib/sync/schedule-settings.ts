/**
 * A meal-time or whole-day-shift edit, queued onto `user_settings.slot_times` / `shift_minutes`
 * (Phase 17 O4a, review round 1 BLOCK 1).
 *
 * Today reads the schedule from the phone's Settings; the period planner and the coach's viewed day
 * read it from the server row (lib/plan-schedule.ts). Before this, an edit stayed on the phone, so
 * Today said 09:30 breakfast while the planner said 12:30 lunch. Every non-silent store save that
 * changes the schedule calls this (lib/store.ts `setOnScheduleEdit`, registered by
 * lib/sync/account-sync.ts), whichever writer made the edit.
 *
 * The write goes through the ordinary settings-intent path with a payload of the two columns alone,
 * like the time-zone capture (lib/sync/settings.ts `captureTimeZone`): the fold records an intent
 * only for a column that differs from the row this device last knew, and the op the drain sends is
 * that row plus the intents, so no other column is touched. A pull never writes the store's
 * schedule, so it cannot echo back as an edit.
 */
import type { AccountHandle } from "@/lib/device/account";
import { scheduleRowFromSettings } from "@/lib/plan-schedule";
import type { Settings } from "@/lib/types";
import { announceQueued, mutateUserSettings, USER_SETTINGS_KEY } from "./outbox";
import { opKind, SETTINGS_ENTITY } from "./settings-intents";

export async function queueScheduleEdit(
  h: AccountHandle, settings: Pick<Settings, "slotTimes" | "shiftMinutes">, now: number = Date.now(),
): Promise<void> {
  const columns = scheduleRowFromSettings(settings);
  await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    return {
      row: { ...row, ...columns },
      op: { op_id: crypto.randomUUID(), entity: SETTINGS_ENTITY, entity_id: USER_SETTINGS_KEY,
        kind: opKind(rev), base_rev: rev, payload: { ...columns },
        client_ts: new Date(now).toISOString() },
      result: undefined,
    };
  }, now);
  announceQueued();
}
