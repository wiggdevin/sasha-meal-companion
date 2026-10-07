/**
 * The time the user actually ate a logged entry (the reviewer, 2026-09-18): a hold on a snack card opens the
 * same timeline the plan cards use, and releasing calls this with the clock time the user dragged to.
 * The write is the coach's own `move_entry` path — one update op carrying `eaten_at`, `local_date`
 * and the user's zone — so a snack moved by hand and a snack moved by the coach are the same edit.
 */
import { accountHandle } from "@/lib/device/account";
import { retime } from "@/lib/coach/apply-entries";

export function saveExtraTime(date: string, id: string, time: string): Promise<void> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return retime(accountHandle(), id, date, time, tz);
}
