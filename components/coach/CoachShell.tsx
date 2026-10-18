"use client";

import { currentAccountOrNull, isCurrent } from "@/lib/device/account";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { CoachErrorNotice, CoachSendFeedbackToast, threadRestoreFailure } from "./CoachShellCards";
import ShellComposedCards from "@/components/coach/ShellComposedCards";
import CoachSuggestions from "@/components/CoachSuggestions";
import CoachDraftBubble from "@/components/coach/CoachDraftBubble";
import { useBroadcastDockComposerState } from "@/components/coach/use-dock-composer-state";
import CoachFrame from "@/components/coach/CoachFrame";
import type { ChatScope } from "@/components/dock/chat-scope";
import { useSendFeedback } from "@/components/coach/use-send-feedback";
import Transcript, { type TranscriptHandle } from "@/components/coach/Transcript";
import { useAttachmentControls, type CoachShellControls } from "@/components/coach/attachments/useAttachmentTurn";
import {
  nextCoachShellState, type CoachShellEvent, type CoachShellState,
} from "@/components/coach/attachments/shell-state";
import { applyCoachAction } from "@/lib/coach/apply-client";
import { useCoachUndo } from "@/components/coach/use-coach-undo";
import { asksAboutAnotherConversation, COMPOSER_OFFLINE_COPY, initialChatState, localDate, nextChatState,
  type ChatAction, type ChatMessage } from "@/lib/coach/chat-state";
import {
  CoachError, NO_CONNECTION_COPY, fetchOlder, getThread, postTurn, readCache, recentEntriesFor, writeCache,
} from "@/lib/coach-client";
import {
  HISTORY_PAGE_SIZE, oldestMessageSeq, pageMayHaveOlder, prependMessages,
} from "@/lib/coach/thread-history";
import { useCoachDockSubmit } from "@/components/coach/use-dock-submit";
import { loadStore } from "@/lib/store";
import type { CoachAction } from "@/lib/coach/actions";
import type { CoachDraft, CoachTurnRequest } from "@/lib/coach/types";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";
export { CoachComposedCards, CoachErrorNotice, threadRestoreFailure } from "./CoachShellCards";
export { default as CoachFrame } from "@/components/coach/CoachFrame";

export type CoachShellProps = {
  userId: string; threadId: string | null;
  onOpenDraft: (draft: CoachDraft) => void; onThreadSaved: (threadId: string | null) => void;
  header?: ReactNode; toolbar?: ReactNode | ((controls: CoachShellControls) => ReactNode);
  /** `applyAction` queues a block's tapped action on this message's ledger (`compose_action`). */
  /** `sendText` answers whether the chat took the message, so a tapped reply can stay when it did not. */
  renderExtras?: (message: ChatMessage, controls: CoachShellControls,
    messages: readonly ChatMessage[], applyAction: (action: CoachAction) => void,
    sendText: (text: string) => boolean) => ReactNode;
  historySourceThreadId?: string | null;
  historySourceTitle?: string | null;
  onOpenHistorySource?: () => void;
  onClearHistorySource?: () => void;
  onBusyChange?: (busy: boolean) => void;
  /** Where the asks come from (components/dock/chat-scope.ts); every turn carries it. */
  scope?: ChatScope;
  /** The overlay's card fills its parent; /coach fills the visual viewport (CoachFrame). */
  fill?: "viewport" | "parent";
  /** The opening read: `cleared` when it answered and the server's unread clear held (false when the read
   *  failed or the clear write did), with the thread's kind whenever the read answered. */
  onThreadOpened?: (threadId: string, cleared: boolean, kind?: string) => void;
};

export function nextPendingAction(actions: ChatAction[]): ChatAction | undefined {
  return actions.find((action) => action.status === "pending");
}
function initialShellState({ threadId }: { threadId: string | null; userId: string }) {
  const state = initialChatState(threadId);
  if (!threadId) return state as CoachShellState;
  const cached = readCache(currentAccountOrNull(), threadId);
  return nextChatState(state, { type: "restore", messages: cached.messages,
    actions: cached.actions }) as CoachShellState;
}

export default function CoachShell({
  userId, threadId, onOpenDraft, onThreadSaved, header, toolbar, renderExtras,
  historySourceThreadId, historySourceTitle, onOpenHistorySource, onClearHistorySource, onBusyChange,
  scope, fill, onThreadOpened,
}: CoachShellProps) {
  const [state, dispatch] = useReducer(nextCoachShellState, { threadId, userId }, initialShellState);
  // The account this screen was rendered for (Phase 9 §0.4). The gate unmounts it on a switch.
  const [account] = useState(currentAccountOrNull);
  const [tz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [restoring, setRestoring] = useState(!!threadId);
  const [restoreId, setRestoreId] = useState(threadId);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [restoreError, setRestoreError] = useState<"missing" | "denied" | "transient" | null>(null);
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(() => threadId ? pageMayHaveOlder(
    readCache(account, threadId).messages, HISTORY_PAGE_SIZE) : false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null); const sendFeedback = useSendFeedback();
  const [followVersion, setFollowVersion] = useState(0); const runSendFeedback = sendFeedback.run;
  // OD06: the reply being written, until the saved turn replaces it.
  const [draft, setDraft] = useState("");
  /** The turn whose drafts may show: an older turn still streaming never writes over a newer one. */
  const draftTurn = useRef<string | null>(null);
  const transcript = useRef<TranscriptHandle>(null);
  const olderInFlight = useRef(false); const olderPageCommitted = useRef(false);
  const alive = useRef(true);
  const actionInFlight = useRef<string | null>(null);

  const followDispatch = useCallback((event: CoachShellEvent) => {
    // The reader's own send and a whole-thread restore always land in view; anything else (a reply,
    // a card) follows only a reader already at the bottom.
    transcript.current?.captureBeforeUpdate(event.type === "send" || event.type === "restore" || event.type === "reset");
    dispatch(event);
    setFollowVersion((version) => version + 1);
  }, []);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const entry = nextPendingAction(state.actions);
    if (!entry || actionInFlight.current !== null) return;
    actionInFlight.current = entry.action.actionId;
    const settle = (result: Awaited<ReturnType<typeof applyCoachAction>>) => {
      if (!alive.current) return;
      dispatch(result.status === "applied"
        ? { type: "action_applied", actionId: entry.action.actionId, token: result.token,
            ...(result.nutritionUnchecked ? { nutritionUnchecked: true } : {}),
            ...(result.notices?.length ? { notices: result.notices } : {}) }
        : { type: "action_failed", actionId: entry.action.actionId, reason: result.reason });
    };
    // A composed card's tap names its card (`source`), so the server can record its Undo.
    void applyCoachAction(entry.action, { tz, fastPath: entry.fastPath, threadId: state.threadId,
      ...(entry.source ? { source: entry.source } : {}), onSettled: settle })
      .then(settle).catch((error: unknown) => {
        if (alive.current) dispatch({ type: "action_failed", actionId: entry.action.actionId,
          reason: error instanceof Error ? error.message : "That did not save." });
      }).finally(() => { actionInFlight.current = null; });
  }, [state.actions, state.threadId, tz]);

  useEffect(() => {
    const sync = () => dispatch({ type: "connection", online: navigator.onLine });
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    if (!restoreId) return;
    let current = true;
    void getThread(restoreId, { limit: HISTORY_PAGE_SIZE }).then((result) => {
      onThreadOpened?.(restoreId, result.cleared !== false, result.thread?.kind);
      if (!current) return;
      setOlderMessages([]); setOlderError(null);
      followDispatch({ type: "restore", messages: result.messages });
      setHasOlder(pageMayHaveOlder(result.messages, HISTORY_PAGE_SIZE)); setRestoreError(null);
    }).catch((error: unknown) => {
      onThreadOpened?.(restoreId, false);
      if (!current) return;
      const kind = threadRestoreFailure(error);
      setRestoreError(kind);
      if (kind !== "transient") {
        if (account === null || isCurrent(account)) writeCache(account, restoreId, { messages: [], actions: [] });
        followDispatch({ type: "reset" });
        onThreadSaved(null);
      }
    }).finally(() => { if (current) setRestoring(false); });
    return () => { current = false; };
  }, [restoreId, restoreAttempt, userId, onThreadSaved, onThreadOpened, followDispatch, account]);

  useEffect(() => {
    if (restoring || !state.threadId) return;
    if (account !== null && !isCurrent(account)) return;
    writeCache(account, state.threadId, { messages: state.messages, actions: state.actions });
  }, [restoring, state.threadId, state.messages, state.actions, account]);
  const messages = prependMessages(state.messages, olderMessages);
  const loadOlder = useCallback(async () => {
    if (!state.threadId || olderInFlight.current || !hasOlder) return;
    const before = oldestMessageSeq(messages);
    if (before === null) return;
    olderInFlight.current = true; transcript.current?.capturePrependAnchor();
    setLoadingOlder(true); setOlderError(null);
    try {
      const page = await fetchOlder(state.threadId, before, HISTORY_PAGE_SIZE);
      transcript.current?.capturePrependAnchor(); olderPageCommitted.current = true;
      setOlderMessages((current) => prependMessages(current, page.messages));
      setHasOlder(pageMayHaveOlder(page.messages, HISTORY_PAGE_SIZE));
    } catch {
      transcript.current?.cancelPrependAnchor();
      if (alive.current) setOlderError("Couldn’t load earlier messages.");
    } finally {
      olderInFlight.current = false;
      if (alive.current) setLoadingOlder(false);
    }
  }, [hasOlder, messages, state.threadId]);
  useLayoutEffect(() => {
    if (!olderPageCommitted.current) return;
    olderPageCommitted.current = false; transcript.current?.restorePrependAnchor();
    const scroller = transcript.current?.getScroller();
    if (hasOlder && scroller && scroller.scrollTop <= 200) void loadOlder();
  }, [hasOlder, loadOlder, olderMessages]);
  /**
   * DeepSeek audit 2026-10-02, finding 2: the guard clauses below used to be the top of an async
   * function, so a caller awaiting it had no way to tell "declined" apart from "accepted, still in
   * flight" — the dock's submitText always treated the call as a send and cleared the draft. `send`
   * now answers synchronously (`true` once it has committed to the turn, `false` on every early
   * return) and hands the actual network round trip to `sendTurn`, which runs after it returns.
   */
  const send = useCallback((text: string, retryOf?: string | null): boolean => {
    if (restoring || restoreError || state.typing || state.composerDisabled) return false;
    if (!state.threadId && state.retryable && state.pendingMessageId
      && retryOf !== state.pendingMessageId) return false;
    if (onOpenHistorySource && !historySourceThreadId && asksAboutAnotherConversation(text)) {
      onOpenHistorySource?.();
      return false;
    }
    // A Retry sends the failed turn's own id, so the server replays it if it did save.
    const messageId = retryOf ?? crypto.randomUUID();
    setDraft(""); draftTurn.current = messageId;
    followDispatch({ type: "send", messageId, text });
    const clearDraft = () => { if (draftTurn.current === messageId) setDraft(""); };
    void (async () => {
      try {
        const now = new Date();
        const request: CoachTurnRequest & { historySourceThreadId?: string } = {
          threadId: state.threadId, messageId, text,
          now: now.toISOString(), tz,
          recentEntries: recentEntriesFor(localDate(tz, now), tz, loadStore),
          ...(historySourceThreadId ? { historySourceThreadId } : {}),
          ...(scope ? { scope } : {}),
        };
        const onDraft = (next: string) => {
          if (!alive.current || draftTurn.current !== messageId) return;
          transcript.current?.captureBeforeUpdate();
          setDraft(next);
          setFollowVersion((version) => version + 1);
        };
        const result = await runSendFeedback(() => postTurn(request, { onDraft }));
        if (!alive.current) return; clearDraft(); if (!result.ok) throw result.error;
        const response = result.value;
        followDispatch({ type: "turn", response });
        onThreadSaved(response.threadId);
        if (historySourceThreadId) onClearHistorySource?.();
      } catch (caught) {
        if (!alive.current) return;
        clearDraft();
        const error = caught instanceof CoachError
          ? caught : new CoachError(0, "network", NO_CONNECTION_COPY);
        followDispatch({ type: "error", status: error.status, code: error.code,
          message: error.message, retryAfterSeconds: error.retryAfterSeconds, messageId });
      }
    })();
    return true;
  }, [followDispatch, historySourceThreadId, onClearHistorySource, onOpenHistorySource,
    onThreadSaved, restoreError, restoring, runSendFeedback, scope, state, tz]);
  useCoachDockSubmit(send, !restoring && !restoreError && !state.typing && !state.composerDisabled);

  const unresolvedFirstTurn = !state.threadId && state.retryable && !!state.pendingMessageId;
  const turnBlocked = state.composerDisabled || restoring || state.typing || !!restoreError;
  const composerOff = turnBlocked || unresolvedFirstTurn;
  const controls = useAttachmentControls({ blocked: turnBlocked,
    newTurnBlocked: unresolvedFirstTurn,
    scanBlocked: restoring || state.typing || !!restoreError,
    threadId: state.threadId, tz, scope, alive, dispatch: followDispatch, onThreadSaved,
    sendText: (text) => void send(text),
    onBlockStatus: (blockId, status, entryIds) => followDispatch({
      type: "block_status", blockId, status, entryIds,
    }) });
  const { undo, shown: shownActions } = useCoachUndo({ account, threadId: state.threadId, ready: !restoring,
    reloadKey: restoreAttempt, alive, dispatch, messages, actions: state.actions });
  const busy = restoring || state.typing || shownActions.some((entry) =>
    entry.status === "pending" || entry.status === "undoing");
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  // The dock's ask field is mounted outside this tree (AppChrome, beside the page); broadcast the
  // disabled state it needs so it disables and shows the offline copy on /coach exactly as the
  // removed page composer did. Scan keeps its own narrower gate: it stays reachable offline.
  useBroadcastDockComposerState({ disabled: composerOff, scanDisabled: controls.scanDisabled,
    offline: state.composerDisabled, thinking: state.typing,
    sendFeedbackState: sendFeedback.controlProps["data-feedback-state"],
    sendFeedbackClassName: sendFeedback.controlProps.className });
  const transcriptFooter = <>
    {restoring && <p role="status">Loading saved messages…</p>}
    {restoreError && (restoreError === "denied"
      ? <Notice tone="error" title="Sign in to read your conversation.">
          <a className="tap underline" href="/sign-in?next=/coach">Sign in</a>
        </Notice>
      : restoreError === "missing"
      ? <Notice tone="error" title="This conversation is no longer available."
          action={{ label: "Start a new conversation", onClick: () => {
            setRestoreId(null); setRestoreError(null); setOlderMessages([]);
            setHasOlder(false); followDispatch({ type: "reset" });
          } }} />
      : <Notice tone="error" title="Could not refresh saved messages. Your saved copy is shown."
          action={{ label: "Retry loading", disabled: restoring, onClick: () => {
            setRestoring(true); setRestoreAttempt((attempt) => attempt + 1);
          } }} />)}
    {state.typing && <CoachDraftBubble draft={draft} />}
    <CoachSuggestions suggestions={state.suggestions} draft={state.draft} onOpenDraft={onOpenDraft} />
    <ShellComposedCards composed={state.composed} messages={state.messages} blocksShown={!!renderExtras} tz={tz}
      onAction={(action, cardIndex, messageId) => dispatch({ type: "compose_action", action, cardIndex, messageId })} />
    {state.error && !sendFeedback.notice && <CoachErrorNotice message={state.error} retryable={state.retryable}
      detail={unresolvedFirstTurn ? "This reply may have saved. Try again to recover it before sending another message. You can start a new conversation from Conversations." : undefined}
      onRetry={() => { void (controls.retryableAttachmentMessageId !== null
        && controls.retryableAttachmentMessageId === state.pendingMessageId
        ? controls.retryAttachment() : send(state.pendingText, state.pendingMessageId)); }} />}
  </>;

  return <CoachFrame fill={fill}
    header={header}
    transcript={<Transcript ref={transcript} messages={messages} actions={shownActions}
      contentVersion={followVersion} hasOlder={hasOlder} loadingOlder={loadingOlder}
      onLoadOlder={() => void loadOlder()} onUndo={(entry) => void undo(entry)}
      onRetryAction={(actionId) => dispatch({ type: "action_retry", actionId })}
      historyError={olderError} onRetryHistory={() => void loadOlder()}
      renderExtras={renderExtras ? (message) => renderExtras(message, controls, messages,
        (action) => dispatch({ type: "compose_action", action, messageId: message.id }),
        (text) => send(text)) : undefined}>
      {transcriptFooter}</Transcript>}
    composer={<div className="flex flex-col gap-2 px-4 pb-2">
      {onOpenHistorySource && <div className="flex min-w-0 flex-wrap gap-2">
        <Button variant="tertiary" size="sm" onClick={onOpenHistorySource} disabled={busy}>Ask from history</Button>
        {historySourceThreadId && <Button variant="tertiary" size="sm" onClick={onClearHistorySource}
          disabled={busy} aria-label="Remove history source" className="max-w-full">
          <span className="truncate">Using {historySourceTitle || (historySourceThreadId === state.threadId
            ? "this conversation" : "saved conversation")} · Remove</span>
        </Button>}
      </div>}
      {/* The page's own composer box is gone (the dock is the one ask field now); this slot keeps
          only what the dock cannot host itself: the history chip above and the send toast below. */}
      {typeof toolbar === "function" ? toolbar(controls) : toolbar}
      <CoachSendFeedbackToast notice={sendFeedback.notice} onDismiss={sendFeedback.dismiss} unresolved={unresolvedFirstTurn}
        retryable={!!state.error && state.retryable} onRetry={() => { void (controls.retryableAttachmentMessageId !== null && controls.retryableAttachmentMessageId === state.pendingMessageId
            ? controls.retryAttachment() : send(state.pendingText, state.pendingMessageId)); }} />
    </div>}
  />;
}
export { COMPOSER_OFFLINE_COPY };
