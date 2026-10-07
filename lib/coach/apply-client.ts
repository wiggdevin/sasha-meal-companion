"use client";

/**
 * Apply grounded coach actions through the same client writes the Today screen already uses.
 *
 * This file is the DISPATCHER: idempotency, the in-flight guard, the timeout, the timing run and
 * Undo. Each kind's write and Undo is bound in lib/coach/actions/apply.ts, delegating to the module
 * that owns it — lib/coach/apply-log.ts (entries), lib/coach/apply-slot.ts (plan slots) and the
 * rest — with the shared token and macro helpers in lib/coach/apply-shared.ts (T6 §6).
 *
 * Undo is also recorded on the server (audit 2026-10-04 P1 #6, lib/coach/undo-client.ts): an
 * applied action posts its token, and `undoCoachAction` asks the server first, so Undo works from
 * another device, after storage was cleared, and past the local cap. The local token is used only
 * when the server certainly did not undo it (no record, a phone-only kind, a write not synced
 * yet), and the record is then marked undone inside the same per-action lock.
 */

import type { CoachAction } from "@/lib/coach/actions";
import { applyBindingFor } from "@/lib/coach/actions/apply";
import { beginRun, discardRun, dropMark, mark, markMs, measure } from "@/lib/timing";
import type { ApplyContext, ApplyResult, UndoOutcome, UndoToken } from "@/lib/coach/apply-shared";
import { accountKey, currentAccountOrNull, isCurrent, type AccountHandle } from "@/lib/device/account";
import { projectServerUndo } from "@/lib/coach/undo-projection";
import {
  isUndoneHere, markUndoneLocally, resetUndoRecords, startRecording, undoViaServer,
} from "@/lib/coach/undo-client";

export type { ApplyContext, ApplyResult, UndoOutcome, UndoToken } from "@/lib/coach/apply-shared";
/** `nutritionUnchecked`, `already`: as on `UndoOutcome`, for an Undo that settled after its timeout. */
export type UndoSettlement =
  | { status: "undone"; nutritionUnchecked?: true; already?: true } | { status: "failed"; reason: string };
export type UndoContext = {
  fastPath?: boolean; onSettled?: (result: UndoSettlement) => void; fetchImpl?: typeof fetch;
};

/** The account's own marks (Phase 9 §0.4): `smc:u:<userId>:coach-action:<id>` and `…:index`. */
const APPLIED_ACTION_PREFIX = "coach-action:";
const APPLIED_ACTION_INDEX = `${APPLIED_ACTION_PREFIX}index`;
const APPLIED_ACTION_LIMIT = 50;
const applying = new Map<string, Promise<ApplyResult>>();
const undoing = new Map<string, Promise<UndoOutcome>>();

/** Phase 9 §0.3: forget the last account's in-flight applies and undos. */
export function resetApplyState(): void {
  applying.clear();
  undoing.clear();
  resetUndoRecords();
}
export const ACTION_TIMEOUT_MS = 20_000;
export const ACTION_TIMEOUT_REASON = "Still saving…";
export const ACTION_PENDING_REASON = ACTION_TIMEOUT_REASON;
export const UNDO_TIMEOUT_REASON = "Undo is still saving…";
export const UNDO_PENDING_REASON = UNDO_TIMEOUT_REASON;

function withTimeout<T>(promise: Promise<T>, reason: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ACTION_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The storage key of one mark of `h`'s, or null with no account (then nothing is remembered). */
function markKey(h: AccountHandle | null, name: string): string | null {
  return h === null ? null : accountKey(h, `${APPLIED_ACTION_PREFIX}${name}`);
}

function recalled(h: AccountHandle | null, actionId: string): ApplyResult | null {
  const key = markKey(h, actionId);
  if (key === null) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const result = JSON.parse(raw) as ApplyResult;
    return result.status === "applied" ? result : null;
  } catch { return null; }
}

function recallIds(h: AccountHandle): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(accountKey(h, APPLIED_ACTION_INDEX)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

/** Only for the account that applied it, and only while it is still the one bound. */
function remember(h: AccountHandle | null, actionId: string, result: ApplyResult): void {
  if (result.status !== "applied" || h === null || !isCurrent(h)) return;
  // `nutritionUnchecked` is said once, for this apply; a recalled result never repeats it.
  const { nutritionUnchecked: _said, ...stored } = result;
  try {
    localStorage.setItem(accountKey(h, `${APPLIED_ACTION_PREFIX}${actionId}`), JSON.stringify(stored));
    const ids = [...recallIds(h).filter((id) => id !== actionId), actionId];
    const kept = ids.slice(-APPLIED_ACTION_LIMIT);
    for (const evicted of ids.slice(0, -APPLIED_ACTION_LIMIT)) {
      localStorage.removeItem(accountKey(h, `${APPLIED_ACTION_PREFIX}${evicted}`));
    }
    localStorage.setItem(accountKey(h, APPLIED_ACTION_INDEX), JSON.stringify(kept));
  }
  catch { /* The in-flight guard still prevents concurrent duplicate writes. */ }
}

function forget(h: AccountHandle | null, actionId: string): void {
  if (h === null || !isCurrent(h)) return;
  try {
    localStorage.removeItem(accountKey(h, `${APPLIED_ACTION_PREFIX}${actionId}`));
    localStorage.setItem(accountKey(h, APPLIED_ACTION_INDEX),
      JSON.stringify(recallIds(h).filter((id) => id !== actionId)));
  } catch { /* The write was still undone; a stale recall can only suppress a repeat apply. */ }
}

/** Design §8.5: a kind this build has no binding for fails honestly instead of writing anything. */
function runApply(action: CoachAction, ctx: ApplyContext): Promise<ApplyResult> {
  const binding = applyBindingFor(action.kind);
  if (!binding) return Promise.resolve({ status: "failed", reason: "That did not save." });
  return binding.apply(action, ctx);
}

export async function applyCoachAction(action: CoachAction, ctx: ApplyContext): Promise<ApplyResult> {
  const h = currentAccountOrNull();
  const prior = recalled(h, action.actionId);
  if (prior) return prior;
  const pending = applying.get(action.actionId);
  if (pending) return { status: "failed", reason: ACTION_PENDING_REASON };
  // T0 §1: one run per action card — the budget in spec §6 is "action card applied ≤ 5 s". Its own
  // handle, like every other path's: two cards applied together are two taps, and a failed one
  // must take its own run with it rather than whichever is latest (Grok pass 25, LOW 4).
  const run = beginRun("coach-action");
  mark("coach-action", "action-applied", run);
  const timingStarted = Date.now();
  const measureFailure = () => {
    dropMark("coach-action", "action-applied", run);
    markMs("coach-action", "action-failed", Date.now() - timingStarted, run);
    measure("coach-action", run);
  };
  let timedOut = false;
  const work = (async (): Promise<ApplyResult> => {
    try {
      const result = await runApply(action, ctx);
      remember(h, action.actionId, result);
      if (result.status === "applied" && h !== null && isCurrent(h)) {
        void startRecording(h, action, result.token,
          { threadId: ctx.threadId, source: ctx.source, fetchImpl: ctx.fetchImpl });
      }
      return result;
    } catch (error) {
      return { status: "failed",
        reason: error instanceof Error ? error.message : "That did not save." };
    }
  })();
  applying.set(action.actionId, work);
  void work.then((result) => {
    if (applying.get(action.actionId) === work) applying.delete(action.actionId);
    if (timedOut) ctx.onSettled?.(result);
  });
  try {
    const result = await withTimeout(work, ACTION_TIMEOUT_REASON);
    // Only an action that was applied is a sample. A failure or a timeout measured alongside the
    // ones that worked would pull the p95 the budget is judged on in whichever direction the
    // failures happened to lie (Grok pass 2, LOW 15); `postTurn` already works this way.
    if (result.status === "applied") measure("coach-action", run);
    else if (ctx.fastPath) measureFailure();
    else discardRun("coach-action", run);
    return result;
  } catch (error) {
    timedOut = true;
    if (ctx.fastPath) measureFailure();
    else discardRun("coach-action", run);
    return { status: "failed",
      reason: error instanceof Error ? error.message : ACTION_TIMEOUT_REASON };
  }
}

export function isCoachActionApplying(actionId: string): boolean {
  return applying.has(actionId);
}

async function performUndo(token: UndoToken): Promise<UndoOutcome> {
  return applyBindingFor(token.kind)?.undo(token);
}

/**
 * Server first (lib/coach/undo-client.ts), then this phone's token. With no account bound, the
 * token alone, as before.
 */
async function undoWork(
  h: AccountHandle | null, actionId: string, token: UndoToken | null, ctx: UndoContext,
): Promise<UndoOutcome> {
  if (h === null) {
    if (!token) throw new Error("Undo is not available here.");
    return performUndo(token);
  }
  const plan = await undoViaServer(h, actionId, token !== null, { fetchImpl: ctx.fetchImpl });
  if (plan.via === "server") {
    projectServerUndo(h, plan.record, token);
    // `already` (t23 #8): this tap did not freshly undo it — see lib/coach/undo-client.ts.
    return plan.already ? { already: true } : undefined;
  }
  if (plan.via === "none") return { already: true };
  if (!token) return;
  // Another tab of this phone may have undone it while the server was asked.
  if (isUndoneHere(h, actionId)) return { already: true };
  const outcome = await performUndo(token);
  // Inside the lock: the record is undone (or created undone) before another Undo can start.
  await markUndoneLocally(h, { actionId, kind: token.kind }, token, { fetchImpl: ctx.fetchImpl });
  return outcome;
}

/**
 * Undo one applied coach action. `token` is this phone's local token, or null on a device that
 * has none (another phone applied it, or storage was cleared): the server record then does it.
 */
export async function undoCoachAction(
  actionId: string, token: UndoToken | null | undefined, ctx: UndoContext = {},
): Promise<UndoOutcome> {
  if (undoing.has(actionId)) throw new Error(UNDO_PENDING_REASON);
  const timingRun = ctx.fastPath ? beginRun("coach-action") : null;
  if (timingRun) mark("coach-action", "action-undone", timingRun);
  let timedOut = false;
  const h = currentAccountOrNull();
  const work = undoWork(h, actionId, token ?? null, ctx).then((outcome) => {
    forget(h, actionId);
    return outcome;
  });
  undoing.set(actionId, work);
  void work.then((outcome) => {
    if (undoing.get(actionId) === work) undoing.delete(actionId);
    if (timedOut) ctx.onSettled?.({ status: "undone",
      ...(outcome?.nutritionUnchecked ? { nutritionUnchecked: true } : {}),
      ...(outcome?.already ? { already: true } : {}) });
  }, (error: unknown) => {
    if (undoing.get(actionId) === work) undoing.delete(actionId);
    if (timedOut) ctx.onSettled?.({ status: "failed",
      reason: error instanceof Error ? error.message : "Undo did not save." });
  });
  try {
    const outcome = await withTimeout(work, UNDO_TIMEOUT_REASON);
    if (timingRun) measure("coach-action", timingRun);
    return outcome;
  }
  catch (error) {
    if (error instanceof Error && error.message === UNDO_TIMEOUT_REASON) timedOut = true;
    if (timingRun) discardRun("coach-action", timingRun);
    throw error;
  }
}
