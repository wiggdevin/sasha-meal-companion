"use client";

/**
 * The phone half of Followups #1 (drop one confirmed taste dislike, with an exact Undo). Mirrors
 * lib/profile/taste-confirm-client.ts exactly: the server computes and records what actually
 * happened (lib/server/taste-dislike-remove.ts); the phone sends the request and settles the
 * `user_settings` row the server answers with, as a pull (`applyServerUserSettings`), so the
 * Settings mirror shows the removal and every pending local edit is rebased onto it.
 *
 * Not gated by `TASTE_CHIPS_ENABLED` — a dislike pill can already be on the row from the sync path
 * with chips off, so removing one is not either.
 *
 * - One action id per user tap (`newTasteDislikeActionId`). `removeTasteDislike` mints one when the
 *   caller does not supply `opts.actionId`; a retry of the SAME tap (after a timeout or a lost
 *   answer) should pass the id back in `opts.actionId` — the server answers its stored receipt
 *   (`status: "existing"`) and changes nothing further. The outcome always echoes the id used, so
 *   the caller can keep it for both the retry and the Undo tap without re-deriving it.
 * - Offline, nothing is sent: `{ ok: false, reason: "offline" }`.
 * - A network failure, a lost answer, a 429 or a 5xx is `retry` (reuse the same action id); any
 *   other 4xx is `refused` with its code. A success fires `SYNCED_EVENT` after the row settles.
 */
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/foods/rules-epoch";
import { applyServerUserSettings } from "@/lib/sync/client";
import type { TasteDislike } from "@/lib/profile/taste";
import type {
  TasteDislikeRemoveResult, TasteDislikeRemoveUndoResult,
} from "@/lib/profile/taste-dislike-remove";

export type TasteDislikeWriteOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; reason: "offline" }
  | { ok: false; reason: "retry"; message: string }
  | { ok: false; reason: "refused"; status: number; code: string; message: string };

type Options = { account?: AccountHandle; fetchImpl?: typeof fetch; online?: () => boolean };

const defaultOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

/** A fresh idempotency key for one remove (or Undo) tap. */
export function newTasteDislikeActionId(): string {
  return crypto.randomUUID();
}

async function post<T extends { settings: Record<string, unknown> | null }>(
  path: string, body: unknown, opts: Options,
): Promise<TasteDislikeWriteOutcome<T>> {
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

/**
 * Drop one confirmed taste dislike. Mints an action id (`newTasteDislikeActionId`) unless the
 * caller passes one back in `opts.actionId` for a retry of the same tap; the settings mirror
 * updates from the server's row on success. The server's own `actionId` on the result is the one
 * to hand to `undoRemoveTasteDislike` for the Undo toast.
 */
export function removeTasteDislike(key: TasteDislike,
  opts: Options & { actionId?: string } = {}): Promise<TasteDislikeWriteOutcome<TasteDislikeRemoveResult>> {
  const actionId = opts.actionId ?? newTasteDislikeActionId();
  return post<TasteDislikeRemoveResult>("/api/profile/taste/dislikes/remove", { actionId, key }, opts);
}

/** Undo one remove by its action id (the SAME id `removeTasteDislike` used). */
export function undoRemoveTasteDislike(actionId: string,
  opts: Options = {}): Promise<TasteDislikeWriteOutcome<TasteDislikeRemoveUndoResult>> {
  return post<TasteDislikeRemoveUndoResult>("/api/profile/taste/dislikes/remove/undo", { actionId }, opts);
}
