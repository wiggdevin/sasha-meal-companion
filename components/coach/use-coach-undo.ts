"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject } from "react";
import { undoCoachAction, UNDO_TIMEOUT_REASON } from "@/lib/coach/apply-client";
import { listCoachUndos, type CoachUndoView } from "@/lib/coach/undo-client";
import { isCurrent, type AccountHandle } from "@/lib/device/account";
import { undoTasteChips } from "@/lib/profile/taste-confirm-client";
import type { ChatAction, ChatEvent, ChatMessage } from "@/lib/coach/chat-state";
import { withServerUndos, type ServerUndoProgress } from "@/components/coach/server-undo";

/**
 * The coach screen's Undo (C4): this phone's token when it holds one, else the server's record.
 * When the thread opens it reads the thread's server records, so an action another device applied
 * shows its card and, when the server can undo it, its Undo; `shown` is the transcript's list.
 */
export function useCoachUndo({ account, threadId, ready, reloadKey, alive, dispatch, messages, actions }: {
  account: AccountHandle | null; threadId: string | null; ready: boolean; reloadKey: unknown;
  alive: RefObject<boolean>; dispatch: Dispatch<ChatEvent>;
  messages: readonly ChatMessage[]; actions: readonly ChatAction[];
}) {
  const inFlight = useRef(new Set<string>());
  const [records, setRecords] = useState<CoachUndoView[]>([]);
  const [progress, setProgress] = useState<ServerUndoProgress>({});

  useEffect(() => {
    if (!ready || !threadId || account === null || !isCurrent(account)) return;
    let current = true;
    void listCoachUndos(account, { threadId }).then((next) => {
      if (current) { setRecords(next); setProgress({}); }
    }).catch(() => undefined);
    return () => { current = false; };
  }, [ready, reloadKey, threadId, account]);

  /** An entry with no token on this phone: the server performs its Undo, or says why it cannot. */
  const undoOnServer = useCallback(async (actionId: string) => {
    const report = (next: ServerUndoProgress[string]) => {
      if (alive.current) setProgress((all) => ({ ...all, [actionId]: next }));
    };
    report({ status: "undoing" });
    try {
      const outcome = await undoCoachAction(actionId, null, { onSettled: (result) => report(result.status === "undone"
        ? { status: "undone", ...(result.already ? { already: true } : {}) } : { status: "failed", reason: result.reason }) });
      report({ status: "undone", ...(outcome?.already ? { already: true } : {}) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Undo did not save.";
      report(reason === UNDO_TIMEOUT_REASON ? { status: "undoing", reason } : { status: "failed", reason });
    }
  }, [alive]);

  /**
   * A confirmed taste-chip record (record_mode `taste_v1`): the Undo list routes its Undo through
   * the taste confirm/undo contract (POST /api/profile/taste/undo), not the generic coach undo, so
   * the answer carries which keys it actually removed and which had already left the row — and the
   * settings mirror comes back the same way the confirm left it (lib/sync/client.ts
   * applyServerUserSettings), through the same call the coach card's own inline Undo uses.
   */
  const undoTaste = useCallback(async (actionId: string) => {
    const report = (next: ServerUndoProgress[string]) => {
      if (alive.current) setProgress((all) => ({ ...all, [actionId]: next }));
    };
    report({ status: "undoing" });
    if (account === null) { report({ status: "failed", reason: "No account is signed in." }); return; }
    try {
      const outcome = await undoTasteChips(actionId, { account });
      if (!outcome.ok) {
        report({ status: "failed",
          reason: outcome.reason === "offline" ? "No connection. Try again." : outcome.message });
        return;
      }
      // "already gone" honestly, and told apart: `already_undone` means an earlier tap really did
      // run this Undo (here or on another device) — the RPC repeats that first call's nonempty
      // `removed` keys on the repeat, so `status` is checked before `removed`'s own count, not
      // after. A genuine first call that removed nothing (the keys left the row some other way)
      // is a different fact and gets its own wording, not the shared "already undone" copy.
      if (outcome.result.status === "already_undone") {
        report({ status: "undone", already: true });
      } else if (outcome.result.removed.dislikes.length + outcome.result.removed.cuisines.length === 0) {
        report({ status: "undone", reason: "Those had already changed in your settings, so Undo made no change." });
      } else {
        report({ status: "undone" });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Undo did not save.";
      report({ status: "failed", reason });
    }
  }, [alive, account]);

  const undoWithToken = useCallback(async (entry: ChatAction & { token: NonNullable<ChatAction["token"]> }) => {
    const actionId = entry.action.actionId;
    dispatch({ type: "action_undo_started", actionId });
    try {
      const outcome = await undoCoachAction(actionId, entry.token, { fastPath: entry.fastPath, onSettled: (result) => {
        if (!alive.current) return;
        dispatch(result.status === "undone"
          ? { type: "action_undone", actionId, ...(result.already ? { already: true } : {}) }
          : { type: "action_failed", actionId, reason: result.reason });
      } });
      if (alive.current) dispatch({ type: "action_undone", actionId, ...(outcome?.already ? { already: true } : {}) });
    } catch (error) {
      if (alive.current) {
        const reason = error instanceof Error ? error.message : "Undo did not save.";
        dispatch(reason === UNDO_TIMEOUT_REASON ? { type: "action_undo_waiting", actionId }
          : { type: "action_failed", actionId, reason });
      }
    }
  }, [alive, dispatch]);

  const undo = useCallback(async (entry: ChatAction) => {
    const actionId = entry.action.actionId;
    if (inFlight.current.has(actionId) || (!entry.token && !entry.serverUndoable)) return;
    inFlight.current.add(actionId);
    try {
      if (entry.token) await undoWithToken({ ...entry, token: entry.token });
      else if (entry.server?.card.type === "taste") await undoTaste(actionId);
      else await undoOnServer(actionId);
    } finally {
      inFlight.current.delete(actionId);
    }
  }, [undoOnServer, undoWithToken, undoTaste]);

  return { undo, shown: withServerUndos(messages, actions, records, progress, account) };
}
