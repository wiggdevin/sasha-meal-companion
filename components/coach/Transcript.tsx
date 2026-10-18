"use client";

import {
  Fragment, forwardRef, useImperativeHandle, useState, type ReactNode,
} from "react";
import CoachActionCard from "@/components/CoachActionCard";
import CoachMessage from "@/components/CoachMessage";
import NewMessagePill from "@/components/coach/NewMessagePill";
import { isCoachActionApplying } from "@/lib/coach/apply-client";
import type { ChatAction, ChatMessage } from "@/lib/coach/chat-state";
import { useBottomFollow } from "@/lib/coach/use-bottom-follow";
import Notice from "@/components/ui/Notice";
import { ASSISTANT_NAME } from "@/lib/brand";
import styles from "./Transcript.module.css";

export type TranscriptHandle = {
  cancelPrependAnchor: () => void;
  captureBeforeUpdate: (force?: boolean) => void;
  capturePrependAnchor: () => void;
  getScroller: () => HTMLDivElement | null;
  restorePrependAnchor: () => void;
};
type Props = {
  messages: readonly ChatMessage[];
  actions?: readonly ChatAction[];
  contentVersion: unknown;
  children?: ReactNode;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  onUndo?: (entry: ChatAction) => void;
  onRetryAction?: (actionId: string) => void;
  historyError?: string | null;
  onRetryHistory?: () => void;
  renderExtras?: (message: ChatMessage) => ReactNode;
};
const Transcript = forwardRef<TranscriptHandle, Props>(function Transcript({
  messages, actions = [], contentVersion, children, hasOlder = false, loadingOlder = false,
  onLoadOlder, onUndo, onRetryAction, historyError, onRetryHistory, renderExtras,
}, ref) {
  const follow = useBottomFollow(contentVersion);
  // Only a reply that lands while the chat is open is read out: never the restored history or an
  // older page (the transcript itself is not a live region, so VoiceOver does not queue it all).
  const latest = messages.at(-1);
  const latestId = latest?.id ?? null;
  const [spoken, setSpoken] = useState({ latestId, text: "" });
  if (spoken.latestId !== latestId) {
    const fresh = spoken.latestId !== null && latest?.role === "assistant" && !latest.pending;
    setSpoken({ latestId, text: fresh ? `${ASSISTANT_NAME}: ${latest.content}` : spoken.text });
  }
  const card = (entry: ChatAction) => (
    <CoachActionCard key={entry.action.actionId} action={entry.action} server={entry.server} status={entry.status}
      reason={entry.reason} nutritionUnchecked={entry.nutritionUnchecked} already={entry.already} notices={entry.notices}
      canUndo={entry.token !== undefined || entry.serverUndoable === true}
      busy={isCoachActionApplying(entry.action.actionId) || entry.status === "undoing"}
      onUndo={() => onUndo?.(entry)}
      onRetry={() => onRetryAction?.(entry.action.actionId)}
    />
  );

  useImperativeHandle(ref, () => ({
    cancelPrependAnchor: follow.cancelPrependAnchor,
    captureBeforeUpdate: follow.captureBeforeUpdate,
    capturePrependAnchor: follow.capturePrependAnchor,
    getScroller: () => follow.scroller.current,
    restorePrependAnchor: follow.restorePrependAnchor,
  }), [
    follow.cancelPrependAnchor, follow.captureBeforeUpdate, follow.capturePrependAnchor,
    follow.restorePrependAnchor, follow.scroller,
  ]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={follow.scroller}
        role="region"
        aria-label="Conversation"
        className={`${styles.scroller} min-h-0 flex-1 overflow-y-auto`}
        style={{ overscrollBehavior: "contain" }}
        onScroll={() => {
          follow.onScroll();
          if (hasOlder && !loadingOlder && follow.scroller.current
            && follow.scroller.current.scrollTop <= 200) {
            onLoadOlder?.();
          }
        }}
      >
        {/* 16 px gutters (DESIGN.md §Layout): bubbles and cards never run to the screen edge. */}
        <div ref={follow.content} className="flex flex-col gap-3 px-4 py-3">
          {historyError && <Notice tone="error" title={historyError}
            action={{ label: "Retry", onClick: () => onRetryHistory?.() }} />}
          {messages.map((message) => (
            <Fragment key={message.id}>
              <CoachMessage role={message.role} content={message.content} pending={message.pending} provenance={message.provenance} />
              {renderExtras?.(message)}
              {actions.filter((entry) => entry.messageId === message.id).map(card)}
            </Fragment>
          ))}
          {/* A server-held card with no message to sit under: a receipt whose source did not match. */}
          {actions.filter((entry) => entry.server && entry.messageId === null).map(card)}
          {children}
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{spoken.text}</p>
      {follow.hasNewMessage && <NewMessagePill onClick={follow.scrollToBottom} />}
    </div>
  );
});

export default Transcript;
