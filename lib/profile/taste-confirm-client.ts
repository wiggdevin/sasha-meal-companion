"use client";

/**
 * The phone half of confirmed taste chips (Phase 18 W5b-2): onboarding, Settings and the coach card
 * call these. The server writes the chips and keeps the receipt (lib/server/taste-confirm.ts); the
 * phone only sends the confirmed request and settles the row the server answered with, as a pull
 * (`applyServerUserSettings`), so the settings mirror shows the write and every pending local edit
 * is rebased onto it.
 *
 * - One action id per user tap (`newTasteActionId`). A retry of that tap — after a timeout or a lost
 *   answer — sends the SAME id and the same chips: the server answers its stored receipt and writes
 *   nothing more. Never reuse an id for other chips (409 `action_conflict`).
 * - Offline, nothing is sent: `{ ok: false, reason: "offline" }`, and the caller keeps the chips
 *   selected and says the confirm waits for a connection. Nothing is queued in the background.
 * - A network failure, a lost answer, a 429 or a 5xx is `retry` (same id); a 4xx is `refused` with
 *   its code. A success fires SYNCED_EVENT after the row is settled, so open screens re-read it.
 */
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/foods/rules-epoch";
import { applyServerUserSettings } from "@/lib/sync/client";
import type {
  TasteConfirmRequest, TasteConfirmResult, TasteUndoResult,
} from "@/lib/profile/taste-confirm";

export type TasteWriteOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; reason: "offline" }
  | { ok: false; reason: "retry"; message: string }
  | { ok: false; reason: "refused"; status: number; code: string; message: string };

type Options = { account?: AccountHandle; fetchImpl?: typeof fetch; online?: () => boolean };

/** A fresh idempotency key for one confirm tap. */
export function newTasteActionId(): string {
  return crypto.randomUUID();
}

const defaultOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

async function post<T extends { settings: Record<string, unknown> | null }>(
  path: string, body: unknown, opts: Options,
): Promise<TasteWriteOutcome<T>> {
  if (!(opts.online ?? defaultOnline)()) return { ok: false, reason: "offline" };
  const h = opts.account ?? accountHandle();
  let response: Response;
  try {
    response = await accountFetch(h, path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }, { budget: "prefs", fetchImpl: opts.fetchImpl });
  } catch (error) {
    rethrowAccountChanged(error);
    return { ok: false, reason: "retry", message: "No connection. Try again." };
  }
  if (!response.ok) {
    const failure = await accountJson<{ error?: unknown; message?: unknown } | null>(h, response)
      .catch((error: unknown) => { rethrowAccountChanged(error); return null; });
    const message = typeof failure?.message === "string" ? failure.message : "That did not save. Try again.";
    if (response.status >= 500 || response.status === 429) return { ok: false, reason: "retry", message };
    return { ok: false, reason: "refused", status: response.status,
      code: typeof failure?.error === "string" ? failure.error : "error", message };
  }
  let result: T;
  try {
    result = await accountJson<T>(h, response);
  } catch (error) {
    // The server may have written, and the answer was lost on the way: the same action id again
    // answers the stored receipt.
    rethrowAccountChanged(error);
    return { ok: false, reason: "retry", message: "No connection. Try again." };
  }
  if (result.settings) {
    await applyServerUserSettings(h, result.settings);
    // An open Settings screen re-reads its state on this event, as after a sync pass.
    globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
  }
  return { ok: true, result };
}

/** Confirm the chips the user kept. The settings mirror updates from the server's row. */
export function confirmTasteChips(request: TasteConfirmRequest,
  opts: Options = {}): Promise<TasteWriteOutcome<TasteConfirmResult>> {
  return post<TasteConfirmResult>("/api/profile/taste/confirm", request, opts);
}

/** Undo one confirm by its action id: only the keys that confirm added and that are still present. */
export function undoTasteChips(actionId: string,
  opts: Options = {}): Promise<TasteWriteOutcome<TasteUndoResult>> {
  return post<TasteUndoResult>("/api/profile/taste/undo", { actionId }, opts);
}
