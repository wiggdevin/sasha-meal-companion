/**
 * The settings recovery replay's own watermark (W026, audit 2026-10-10 A082).
 *
 * A queued settings op with no confirmed baseline makes the pull re-read the change feed from the
 * start, because the feed may never mention a row the cursor has already passed, and only the END
 * of the feed says which settings row is authoritative (lib/sync/client.ts). Restarting at 0 on
 * every pass never reached that end on a feed longer than one pass's page budget, so the op stayed
 * parked for good. The replay now saves how far it has read and the newest settings change it saw,
 * in one META value, and the next pass resumes from there. The feed only grows, so what an earlier
 * pass read is still true; a change read twice (the main cursor rewound below the watermark) is
 * kept only when it is newer than the one held.
 */
import { deleteMeta, getMeta, putMeta, type AccountHandle } from "./idb";
import type { ChangeRow } from "./types";

export const SETTINGS_RECOVERY_KEY = "settings_recovery";

export type SettingsRecovery = {
  /** The feed position the replay has read through. */
  cursor: number;
  /** The newest settings change read so far (`row` null: the server deleted it), or none. */
  seen: { row: Record<string, unknown> | null; rev: number; seq: number } | null;
};

/** The replay in progress, or a fresh one from the start of the feed. */
export async function loadSettingsRecovery(h: AccountHandle): Promise<SettingsRecovery> {
  const saved = await getMeta<SettingsRecovery>(h, SETTINGS_RECOVERY_KEY);
  if (saved && typeof saved.cursor === "number" && saved.cursor >= 0) return saved;
  return { cursor: 0, seen: null };
}

/** No replay is needed (the baseline is known, or no settings op waits): forget any saved one. */
export async function dropSettingsRecovery(h: AccountHandle): Promise<void> {
  if ((await getMeta(h, SETTINGS_RECOVERY_KEY)) !== undefined) await deleteMeta(h, SETTINGS_RECOVERY_KEY);
}

/** Fold one pulled settings change into the replay: the newest by feed position wins. */
export function noteSettingsChange(recovery: SettingsRecovery, change: ChangeRow): SettingsRecovery {
  if (recovery.seen && recovery.seen.seq >= change.seq) return recovery;
  return { ...recovery, seen: { row: change.current, rev: change.rev, seq: change.seq } };
}

/** Save the replay after a whole page applied; the watermark never moves back. */
export async function saveSettingsRecovery(
  h: AccountHandle, recovery: SettingsRecovery, nextCursor: number,
): Promise<SettingsRecovery> {
  const next = { ...recovery, cursor: Math.max(recovery.cursor, nextCursor) };
  await putMeta(h, SETTINGS_RECOVERY_KEY, next);
  return next;
}
