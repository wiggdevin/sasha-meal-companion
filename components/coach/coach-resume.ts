"use client";

/**
 * Which saved chat the coach opens on, for /coach and the dock's chat overlay alike: the one this
 * phone last used for the signed-in account, else the latest chat with messages, else the newest.
 * Moved out of app/coach/CoachScreen.tsx (2026-10-04) so the overlay resumes the same thread.
 */
import { CoachError, listThreads, type ThreadSummary } from "@/lib/coach-client";
import { browserClient } from "@/lib/supabase/client";
import { beginThreadRead } from "@/components/coach/unread-threads";

export type Resume = { userId: string | null; threadId: string | null; loading: boolean; error: string | null };
const currentKey = (userId: string) => `smc:coach:current:${userId}`;

/** The thread each account last chose here, and when (a `beginThreadRead` stamp): a list asked for
 *  before that choice never replaces it. */
const picks = new Map<string, { at: number; threadId: string | null }>();

export function rememberCoachThread(userId: string, threadId: string | null): void {
  picks.set(userId, { at: beginThreadRead(), threadId });
  storeCoachThread(userId, threadId);
}

function storeCoachThread(userId: string, threadId: string | null): void {
  try {
    if (threadId) localStorage.setItem(currentKey(userId), threadId);
    else localStorage.removeItem(currentKey(userId));
  } catch { /* Online thread listing remains authoritative when storage is unavailable. */ }
}

export function cachedCoachThread(userId: string): string | null {
  try { return localStorage.getItem(currentKey(userId)); } catch { return null; }
}

export function resumeChat(threads: readonly ThreadSummary[], preferred: string | null): string | null {
  const chats = threads.filter((thread) => thread.kind === "chat");
  return chats.find((thread) => thread.id === preferred)?.id
    ?? chats.find((thread) => thread.lastMessageAt !== null)?.id
    ?? chats[0]?.id ?? null;
}

/** Ignore results from a previous identity, including a late initial getSession response. `onThreads`
 *  gets the chats, and once it is read the whole list (weekly reviews included) with the stamp taken
 *  when it was asked for (`beginThreadRead`), so a caller can order it against its own list reads. */
export function subscribeCoachResume(onChange: (resume: Resume) => void,
  onThreads?: (threads: ThreadSummary[], userId: string | null, all?: ThreadSummary[],
    startedAt?: number) => void): () => void {
  const auth = browserClient().auth;
  let active = true;
  let generation = 0;
  let authEventSeen = false;
  let failed = false;
  let currentUser: string | null | undefined;
  const change = (userId: string | null, retry = false) => {
    if (!active || (userId === currentUser && !retry)) return;
    failed = false;
    currentUser = userId;
    const request = ++generation;
    onThreads?.([], userId);
    onChange({ userId, threadId: null, loading: !!userId, error: null });
    if (!userId) return;
    const started = beginThreadRead();
    void listThreads().then((threads) => {
      if (!active || request !== generation) return;
      const chats = threads.filter((thread) => thread.kind === "chat");
      // A thread picked (or a new chat started) after this list was asked for stays: the same order
      // check the lists use.
      const pick = picks.get(userId);
      const picked = !!pick && pick.at > started;
      const threadId = picked ? pick.threadId : resumeChat(chats, cachedCoachThread(userId));
      if (!picked) storeCoachThread(userId, threadId);
      onThreads?.(chats, userId, threads, started);
      onChange({ userId, threadId, loading: false, error: null });
    }).catch((error: unknown) => {
      if (!active || request !== generation) return;
      failed = true;
      const denied = error instanceof CoachError && (error.status === 401 || error.status === 403);
      const pick = picks.get(userId);
      onChange({ userId: denied ? null : userId,
        threadId: denied ? null : pick && pick.at > started ? pick.threadId : cachedCoachThread(userId), loading: false,
        error: denied ? "Sign in to continue." : "Could not refresh your conversation. Showing any saved messages." });
    });
  };
  void auth.getSession().then(({ data }) => {
    if (!authEventSeen) change(data.session?.user.id ?? null);
  }).catch(() => { if (!authEventSeen) change(null); });
  const { data } = auth.onAuthStateChange((_event, session) => {
    authEventSeen = true;
    change(session?.user.id ?? null, failed);
  });
  const online = () => { if (failed && currentUser) change(currentUser, true); };
  globalThis.addEventListener?.("online", online);
  return () => {
    active = false; ++generation; data.subscription.unsubscribe();
    globalThis.removeEventListener?.("online", online);
  };
}
