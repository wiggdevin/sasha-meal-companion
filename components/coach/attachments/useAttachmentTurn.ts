"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import type { CoachShellEvent } from "@/components/coach/attachments/shell-state";
import type { ChatScope } from "@/components/dock/chat-scope";
import type { CoachAttachment } from "@/lib/coach/attachments";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";
import { CoachError, NO_CONNECTION_COPY, postAttachmentTurn } from "@/lib/coach-client";

export type CoachShellControls = {
  disabled: boolean;
  scanDisabled: boolean;
  retryableAttachmentMessageId: string | null;
  sendText: (text: string) => void;
  /** Resolves when the whole turn settles. `onDispatched` fires the moment the message is in the
   *  chat, so a sheet can close then instead of waiting on the reply (UI audit 2026-10-18 §6); a
   *  false that comes without it means the send was refused and nothing was posted. */
  sendAttachment: (attachment: CoachAttachment, optimisticText: string,
    opts?: AttachmentSendOptions) => Promise<boolean>;
  retryAttachment: () => Promise<boolean>;
  onBlockStatus: (blockId: string, status: LogDraftBlockV1["status"], entryIds?: string[]) => void;
};

export type AttachmentSendOptions = { onDispatched?: () => void };

type PendingAttachment = {
  threadId: string | null;
  messageId: string;
  attachment: CoachAttachment;
  optimisticText: string;
};

export function useAttachmentControls({
  blocked, newTurnBlocked = false, scanBlocked, threadId, tz, scope, alive, dispatch,
  onThreadSaved, sendText, onBlockStatus,
}: {
  blocked: boolean; newTurnBlocked?: boolean; scanBlocked: boolean;
  threadId: string | null;
  tz: string; scope?: ChatScope;
  alive: RefObject<boolean>;
  dispatch: (event: CoachShellEvent) => void;
  onThreadSaved: (threadId: string | null) => void; sendText: (text: string) => void;
  onBlockStatus: CoachShellControls["onBlockStatus"];
}): CoachShellControls {
  const pending = useRef(new Map<string, PendingAttachment>());
  const inFlight = useRef<string | null>(null);
  const [failedMessageId, setFailedMessageId] = useState<string | null>(null);

  const post = useCallback(async (
    turn: PendingAttachment, firstAttempt: boolean, onDispatched?: () => void,
  ): Promise<boolean> => {
    const attachmentBlocked = turn.attachment.kind === "barcode" ? scanBlocked : blocked;
    if (attachmentBlocked || inFlight.current !== null) return false;
    inFlight.current = turn.messageId;
    dispatch(firstAttempt
      ? { type: "send", messageId: turn.messageId, text: turn.optimisticText,
        attachment: turn.attachment }
      : { type: "attachment_retry" });
    onDispatched?.();
    try {
      const response = await postAttachmentTurn({ threadId: turn.threadId, messageId: turn.messageId,
        text: "", attachment: turn.attachment, tz, ...(scope ? { scope } : {}) } as Parameters<typeof postAttachmentTurn>[0]);
      if (!alive.current) return false;
      dispatch({ type: "turn", response });
      onThreadSaved(response.threadId);
      pending.current.delete(turn.messageId);
      setFailedMessageId((current) => current === turn.messageId ? null : current);
      return true;
    } catch (caught: unknown) {
      if (!alive.current) return false;
      const error = caught instanceof CoachError
        ? caught : new CoachError(0, "network", NO_CONNECTION_COPY);
      setFailedMessageId(turn.messageId);
      dispatch({ type: "attachment_error", status: error.status, code: error.code, message: error.message,
        retryAfterSeconds: error.retryAfterSeconds, messageId: turn.messageId });
      return false;
    } finally {
      inFlight.current = null;
    }
  }, [alive, blocked, dispatch, onThreadSaved, scanBlocked, scope, tz]);

  const sendAttachment = useCallback((
    attachment: CoachAttachment, optimisticText: string, opts?: AttachmentSendOptions,
  ) => {
    const attachmentBlocked = attachment.kind === "barcode" ? scanBlocked : blocked;
    if (attachmentBlocked || newTurnBlocked) return Promise.resolve(false);
    const turn = { threadId, messageId: crypto.randomUUID(), attachment, optimisticText };
    pending.current.set(turn.messageId, turn);
    setFailedMessageId(null);
    return post(turn, true, opts?.onDispatched);
  }, [blocked, newTurnBlocked, post, scanBlocked, threadId]);
  const retryAttachment = useCallback(() => {
    const turn = failedMessageId ? pending.current.get(failedMessageId) : undefined;
    return turn ? post(turn, false) : Promise.resolve(false);
  }, [failedMessageId, post]);

  return {
    disabled: blocked || newTurnBlocked,
    scanDisabled: scanBlocked || newTurnBlocked,
    retryableAttachmentMessageId: failedMessageId,
    sendText,
    sendAttachment,
    retryAttachment,
    onBlockStatus,
  };
}
