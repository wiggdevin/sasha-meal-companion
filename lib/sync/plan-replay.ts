/**
 * W096 (backlog B092): replay the `plan_days` feed rows this phone consumed before its pull
 * projected them correctly.
 *
 * Today reads the legacy store, and a pulled plan day reaches it only through
 * `applyPulledPlanDay`. Rows pulled before that projection (and before the W011 conflict and
 * hold fixes) moved the cursor past them without ever reaching Today, so another device's older
 * edit to a day could stay missing until that day changed again. One replay per version reads the
 * feed from the start up to the cursor the phone had when the replay began, and projects the
 * newest change of each day through the same guarded path: a mirror holding a later revision skips
 * it, and a day with a queued op is left to that op. Rows past that cursor were pulled by current
 * code and are not read again.
 *
 * The replay keeps its own watermark in META, so a feed longer than one pass's page budget
 * resumes where the last pass stopped (a few pages a pass, under the feed's rate limit). Until it
 * finishes, a day may show an earlier page's change. A device that had pulled nothing has nothing
 * to replay.
 */
import { getMeta, putMeta, type AccountHandle } from "./idb";
import type { ChangeRow } from "./types";

export const PLAN_REPLAY_KEY = "plan_days_replay";
/** Raise to make every device replay again after a future projection fix. */
export const PLAN_REPLAY_VERSION = 1;

export type PlanReplay =
  | { version: number; done: true }
  | { version: number; done: false; cursor: number; through: number };

function valid(value: unknown): value is PlanReplay {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "number") return false;
  if (v.done === true) return true;
  return v.done === false && typeof v.cursor === "number" && typeof v.through === "number"
    && v.cursor >= 0 && v.through >= 0;
}

/**
 * The replay still to run for this account, or null when it is done. `storedCursor` is the pull
 * cursor before this pass read anything: a new replay ends there.
 */
export async function pendingPlanReplay(
  h: AccountHandle, storedCursor: number,
): Promise<Extract<PlanReplay, { done: false }> | null> {
  const saved = await getMeta<unknown>(h, PLAN_REPLAY_KEY);
  if (valid(saved) && saved.version >= PLAN_REPLAY_VERSION) return saved.done ? null : saved;
  if (storedCursor <= 0) {
    await finishPlanReplay(h);
    return null;
  }
  const fresh = { version: PLAN_REPLAY_VERSION, done: false as const, cursor: 0, through: storedCursor };
  await putMeta(h, PLAN_REPLAY_KEY, fresh);
  return fresh;
}

export async function savePlanReplay(
  h: AccountHandle, replay: Extract<PlanReplay, { done: false }>,
): Promise<void> {
  if (replay.cursor >= replay.through) await finishPlanReplay(h);
  else await putMeta(h, PLAN_REPLAY_KEY, replay);
}

export async function finishPlanReplay(h: AccountHandle): Promise<void> {
  await putMeta(h, PLAN_REPLAY_KEY, { version: PLAN_REPLAY_VERSION, done: true });
}

/**
 * The newest `plan_days` change of each day in one page, up to `through`. An older change of the
 * same day would only be skipped as stale behind it, at the cost of a full store write each.
 */
export function newestPlanDays(changes: readonly ChangeRow[], through: number): ChangeRow[] {
  const newest = new Map<string, ChangeRow>();
  for (const change of changes) {
    if (change.entity !== "plan_days" || change.seq > through) continue;
    const held = newest.get(change.entity_key);
    if (!held || held.seq < change.seq) newest.set(change.entity_key, change);
  }
  return [...newest.values()].sort((a, b) => a.seq - b.seq);
}
