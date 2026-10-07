"use client";

/**
 * One chat, wherever it is shown: the /coach page and the dock's chat overlay (U22, 2026-10-04).
 * It resumes the account's current chat (components/coach/coach-resume.ts), keeps the saved-chat
 * list, and owns the Conversations picker with its delete, clear and rename (U20) and the confirm
 * sheet a draft opens. Moved out of app/coach/CoachScreen.tsx so both surfaces share it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import CaptureSheet from "@/components/CaptureSheet";
import CoachChat from "@/components/CoachChat";
import CoachFrame from "@/components/coach/CoachFrame";
import ConversationPicker from "@/components/coach/ConversationPicker";
import {
  rememberCoachThread, resumeChat, subscribeCoachResume, type Resume,
} from "@/components/coach/coach-resume";
import { useDockComposerState } from "@/components/coach/use-dock-composer-state";
import type { ChatScope } from "@/components/dock/chat-scope";
import { draftToProposeResponse, listThreads, writeCache, type ThreadSummary } from "@/lib/coach-client";
import { clearThreadMessages, deleteThread, renameThread } from "@/lib/coach/threads-client";
import { currentAccountOrNull, isCurrent } from "@/lib/device/account";
import type { CoachDraft } from "@/lib/coach/types";
import Notice from "@/components/ui/Notice";
import {
  beginThreadOpen, beginThreadRead, dropThreadMark, isDeliveredAgain, noteThreads, settleThreadOpen, subscribeUnread,
  useUnreadThreads,
} from "@/components/coach/unread-threads";

/** The server keeps at most this many chats per account (`coach_chat_limit`). */
export const CHAT_LIMIT = 8;
/** The server's own thread kind for the Sunday review: read here, never answered or managed. */
export const REVIEW_KIND = "weekly_review";

export type CoachHeaderContext = {
  thinking: boolean;
  /** Saved chats, once listed. */
  count: number;
  openConversations: () => void;
};

/** The screen's header, drawn as its own element so its callbacks are handed down, not run, in render. */
function HeaderSlot({ render, ...context }: CoachHeaderContext & { render: (context: CoachHeaderContext) => ReactNode }) {
  return <>{render(context)}</>;
}

export default function CoachConversation({ scope, variant, renderHeader }: {
  scope: ChatScope;
  variant: "page" | "overlay";
  renderHeader: (context: CoachHeaderContext) => ReactNode;
}) {
  const page = variant === "page";
  const [draft, setDraft] = useState<CoachDraft | null>(null);
  const [resume, setResume] = useState<Resume>({ userId: null, threadId: null, loading: true, error: null });
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [reviews, setReviews] = useState<ThreadSummary[]>([]);
  /** Each thread's kind as its own opening read reported it: known even when no list could be read. */
  const [openedKinds, setOpenedKinds] = useState<Record<string, string>>({});
  /** The start stamp of the newest thread list applied here, from the resume or a refresh. */
  const lastList = useRef(-1);
  const unread = useUnreadThreads();
  const [picker, setPicker] = useState<"conversations" | "source" | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [viewEpoch, setViewEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const activeUser = useRef<string | null>(null);
  const listGeneration = useRef(0);
  const [retry, setRetry] = useState(0);
  const { thinking = false } = useDockComposerState(true);
  const refreshThreads = useCallback(async (userId: string) => {
    const request = ++listGeneration.current;
    const account = currentAccountOrNull();
    const active = () => activeUser.current === userId && request === listGeneration.current
      && (!account || isCurrent(account));
    setListLoading(true); setListError(null);
    const started = beginThreadRead();
    try {
      const listed = await listThreads();
      // The full list carries every thread's unread mark, so the dock's badge follows it too.
      noteThreads(listed, account, started);
      if (active() && started > lastList.current) {
        lastList.current = started;
        const chats = listed.filter((thread) => thread.kind === "chat");
        setThreads(chats);
        setReviews(listed.filter((thread) => thread.kind === REVIEW_KIND));
        setSourceId((source) => source && !chats.some((thread) => thread.id === source)
          ? null : source);
      }
    } catch {
      if (active()) setListError("Could not refresh conversations.");
    } finally {
      if (active()) setListLoading(false);
    }
  }, []);
  const rememberThread = useCallback((id: string | null) => {
    if (!resume.userId || activeUser.current !== resume.userId) return;
    rememberCoachThread(resume.userId, id);
    setResume((current) => current.userId === resume.userId ? { ...current, threadId: id } : current);
    if (id) void refreshThreads(resume.userId);
  }, [refreshThreads, resume.userId]);
  useEffect(() => subscribeCoachResume((next) => {
    if (activeUser.current !== next.userId) {
      activeUser.current = next.userId;
      ++listGeneration.current;
      setDraft(null); setSourceId(null); setPicker(null); setBusy(false); setReviews([]); setOpenedKinds({});
      setViewEpoch((epoch) => epoch + 1);
    }
    setResume(next);
  }, (listed, userId, all, started) => {
    if (activeUser.current !== userId) return;
    if (started !== undefined) {
      // The same order as a refresh: an older list answering late never replaces a newer one.
      if (started <= lastList.current) return;
      lastList.current = started;
      noteThreads(all, currentAccountOrNull(), started);
    }
    setThreads(listed);
    if (all) setReviews(all.filter((thread) => thread.kind === REVIEW_KIND));
  }), [retry]);
  /** Each mounted transcript's opening attempt (by view epoch): its read settles only that attempt. */
  const openAttempts = useRef(new Map<number, { id: string; attempt: number }>());
  /**
   * CoachShell's opening read answered: settle the unread mark from the server's `cleared` (a read
   * that answered but whose clear write failed keeps the mark, as a failed read does), and learn the
   * thread's kind, so a resumed review is known as one even when no list could be read.
   */
  const threadOpened = useCallback((id: string, cleared: boolean, kind?: string) => {
    const opening = openAttempts.current.get(viewEpoch);
    if (opening?.id === id) settleThreadOpen(id, cleared, opening.attempt);
    if (typeof kind === "string") {
      setOpenedKinds((known) => known[id] === kind ? known : { ...known, [id]: kind });
    }
  }, [viewEpoch]);
  /** Opens a chat (or a new one) in place of the current one: a fresh transcript, nothing carried. */
  const show = (id: string | null) => {
    if (!resume.userId) return;
    rememberCoachThread(resume.userId, id);
    setResume((current) => ({ ...current, threadId: id }));
    setViewEpoch((epoch) => epoch + 1);
    setDraft(null); setSourceId(null); setBusy(false);
  };
  // A thread on screen is being opened: its unread mark hides at once, pending the transcript's own
  // read (GET /api/coach/threads/[id], which clears the server's mark); CoachShell reports how that
  // read went. A layout effect, so the mark is pending before the read (a passive effect) starts.
  useLayoutEffect(() => {
    if (resume.loading || !resume.threadId) return;
    for (const epoch of openAttempts.current.keys()) if (epoch < viewEpoch) openAttempts.current.delete(epoch);
    openAttempts.current.set(viewEpoch, { id: resume.threadId, attempt: beginThreadOpen(resume.threadId) });
  }, [resume.loading, resume.threadId, viewEpoch]);
  const isReview = (id: string | null) => !!id
    && (openedKinds[id] === REVIEW_KIND || reviews.some((thread) => thread.id === id));
  const reading = isReview(resume.threadId);
  // Reviews append to one thread: a new one arriving while it is open (a list after the read marks it
  // unread again) reloads the transcript, which reads and clears it again.
  useEffect(() => {
    const id = resume.threadId;
    if (!reading || busy || !id) return;
    let live = true;
    const check = () => { if (live && isDeliveredAgain(id)) setViewEpoch((epoch) => epoch + 1); };
    const stop = subscribeUnread(check);
    void Promise.resolve().then(check); // one that came in while a turn or a read was running
    return () => { live = false; stop(); };
  }, [reading, busy, resume.threadId]);
  // "Read it" unmounts the button it was pressed on: focus goes to the review's own heading.
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const focusReview = useRef(false);
  useEffect(() => {
    if (!reading || !focusReview.current) return;
    focusReview.current = false;
    reviewHeading.current?.focus({ preventScroll: true });
  }, [reading, viewEpoch]);
  /** The newest unread review, when it is not the thread on screen. */
  const waitingReview = unread.find((thread) => thread.kind === REVIEW_KIND && thread.id !== resume.threadId);
  const openReview = (review: { id: string; title: string | null; kind: string }) => {
    if (busy || !resume.userId) return;
    setReviews((current) => current.some((thread) => thread.id === review.id) ? current
      : [...current, { ...review, lastMessageAt: null }]);
    focusReview.current = true;
    show(review.id);
  };
  const chooseConversation = (id: string | null) => {
    if (busy || listLoading || !resume.userId || (id === null && threads.length >= CHAT_LIMIT)) return;
    show(id);
    setPicker(null);
  };
  const openPicker = (mode: "conversations" | "source") => {
    setPicker(mode);
    if (resume.userId) void refreshThreads(resume.userId);
  };
  /** A chat's saved transcript on this phone is emptied with it, so a reopen never shows it again. */
  const forget = (id: string) => writeCache(currentAccountOrNull(), id, { messages: [], actions: [] });
  // A weekly review is managed like a chat (rename, clear, delete); clearing or deleting it drops its
  // unread mark here too, as the server does.
  const deleteChat = async (id: string) => {
    await deleteThread(id);
    forget(id);
    dropThreadMark(id);
    const rest = threads.filter((thread) => thread.id !== id);
    setThreads(rest);
    setReviews((current) => current.filter((thread) => thread.id !== id));
    if (sourceId === id) setSourceId(null);
    if (id === resume.threadId) show(resumeChat(rest, null));
  };
  const clearChat = async (id: string) => {
    await clearThreadMessages(id);
    forget(id);
    dropThreadMark(id);
    const emptied = (thread: ThreadSummary) => thread.id === id ? { ...thread, lastMessageAt: null } : thread;
    setThreads((current) => current.map(emptied));
    setReviews((current) => current.map(emptied));
    if (id === resume.threadId) setViewEpoch((epoch) => epoch + 1);
  };
  const renameChat = async (id: string, title: string) => {
    const renamed = await renameThread(id, title);
    const named = (thread: ThreadSummary) => thread.id === id ? { ...thread, title: renamed.title } : thread;
    setThreads((current) => current.map(named));
    setReviews((current) => current.map(named));
  };
  const header = <>
    <HeaderSlot render={renderHeader} thinking={thinking} count={threads.length}
      openConversations={() => openPicker("conversations")} />
    {/* A review names itself, so the chat on screen is clear; "Read it" moves focus here. */}
    {reading && <div className="px-4 pb-2">
      <h2 ref={reviewHeading} tabIndex={-1} className="m-0 font-display text-title font-normal outline-none">
        {reviews.find((thread) => thread.id === resume.threadId)?.title?.trim() || "Weekly review"}
      </h2>
    </div>}
    {waitingReview && <div className="px-4 pb-2">
      <Notice tone="info" title="Your weekly review is ready."
        action={{ label: "Read it", disabled: busy, onClick: () => openReview(waitingReview) }} />
    </div>}
  </>;
  const fill = page ? "viewport" : "parent";
  const notice = <div className="px-4 py-5">
    {resume.loading && <p role="status">Loading your conversation…</p>}
    {resume.error && <Notice tone="error" title={resume.error}
      action={{ label: "Retry loading", onClick: () => setRetry((n) => n + 1) }} />}
  </div>;
  return <>
      {!resume.loading && resume.userId ? <CoachChat key={`${resume.userId}:${viewEpoch}`}
        userId={resume.userId} threadId={resume.threadId} onOpenDraft={setDraft}
        onThreadSaved={rememberThread} header={header} scope={scope} fill={fill}
        onThreadOpened={threadOpened}
        historySourceThreadId={page ? sourceId : null}
        historySourceTitle={threads.find((thread) => thread.id === sourceId)?.title ?? null}
        onOpenHistorySource={page ? () => openPicker("source") : undefined}
        onClearHistorySource={() => setSourceId(null)}
        onOpenConversation={(id) => {
          if (threads.some((thread) => thread.id === id)) chooseConversation(id);
          else if (page) openPicker("conversations");
        }}
        onBusyChange={setBusy} />
        : <CoachFrame header={header} transcript={notice} composer={<div />} fill={fill} />}
      <AnimatePresence>
      {picker && resume.userId && <ConversationPicker key="picker" mode={picker} threads={threads}
        reviews={reviews}
        currentThreadId={resume.threadId} selectedSourceId={sourceId}
        busy={busy} loading={listLoading} error={listError} limit={CHAT_LIMIT}
        onSelect={(id) => {
          if (listLoading) return;
          if (isReview(id) && picker === "conversations") {
            if (busy) return;
            show(id); setPicker(null); return;
          }
          if (!threads.some((thread) => thread.id === id)) return;
          if (picker === "source") { setSourceId(id); setPicker(null); }
          else chooseConversation(id);
        }}
        onNew={() => chooseConversation(null)} onClose={() => setPicker(null)}
        onRetry={() => { if (resume.userId) void refreshThreads(resume.userId); }}
        onDelete={deleteChat} onClear={clearChat} onRename={renameChat} />}
      {draft && resume.userId && (
        <CaptureSheet
          key="draft"
          open
          initialMode="confirm"
          initialDraft={draftToProposeResponse(draft)}
          onClose={() => setDraft(null)}
          onLogged={() => setDraft(null)}
          onOpenSearch={() => setDraft(null)}
        />
      )}
      </AnimatePresence>
    </>;
}
