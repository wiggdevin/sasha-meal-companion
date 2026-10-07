"use client";

/**
 * After a server Undo, what this phone's own day still shows (review t4r3 #4). The sync pull
 * updates the normalized rows (water, plan days, recipes, the log entry's mirror), but a logged
 * meal also lives in the legacy store's `extras`, which the pull never removes — so the meal and
 * its calories would stay in the day totals. This removes it, as the phone's own Undo does
 * (lib/coach/apply-log.ts `undoLog`), on a device without the token too (the record's `target`).
 */
import type { UndoToken } from "@/lib/coach/apply-shared";
import type { CoachUndoView } from "@/lib/coach/undo-types";
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import { getDay, removeExtra } from "@/lib/store";

export function projectServerUndo(h: AccountHandle, record: CoachUndoView, token: UndoToken | null): void {
  if (record.kind !== "log_meal") return;
  const target = record.target
    ?? (token?.kind === "log_meal" ? { date: token.date, entryId: token.entryId } : undefined);
  if (!target) return;
  assertCurrent(h);
  if (getDay(target.date)?.extras?.some((extra) => extra.id === target.entryId)) {
    removeExtra(target.date, target.entryId);
  }
}
