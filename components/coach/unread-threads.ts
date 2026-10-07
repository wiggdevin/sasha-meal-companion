"use client";

/**
 * Which saved threads hold something the user has not opened yet: today, a delivered weekly review
 * (PR #374: `GET /api/coach/threads` returns `unread` per thread; opening the thread with
 * `GET /api/coach/threads/[id]` clears it on the server). Reviews arrive on each account's own
 * Sunday evening, so the phone asks when the app opens and each time it comes back to the
 * foreground, never while hidden and never more than once per `UNREAD_POLL_GAP_MS`. It asks the cheap
 * count first (`GET /api/coach/threads/unread`) and lists the threads only when the count is above 0;
 * Conversations lists them itself when it opens. A 404 means the coach is off: no badge, no error.
 *
 * One store for the dock's bubble and the Conversations list. It belongs to one account handle:
 * an account change or sign-out empties it before anything else can read it.
 *
 * - Lists apply in the order they were asked for: an answer older than the last one applied is
 *   dropped, whichever came back first.
 * - Opening a thread hides its mark at once, pending the opening read. While pending, no list can
 *   show it; the read's success settles it read (a list asked for before then cannot bring it back),
 *   its failure puts the mark back as the latest list saw it. A list asked for during the read that
 *   still saw the mark cannot tell a new delivery from the read not having cleared yet, so a
 *   successful read then asks once more; still unread means something new arrived (`isDeliveredAgain`).
 * - A failed list leaves the marks as they were and never throws.
 */
import { useEffect, useSyncExternalStore } from "react";
import { listThreads, type CoachFetchOptions, type ThreadSummary } from "@/lib/coach-client";
import { countUnreadThreads } from "@/lib/coach/threads-client";
import {
  isCurrent, onAccountGone, onAccountReady, type AccountHandle,
} from "@/lib/device/account";

/** The shortest gap between two automatic list calls. */
export const UNREAD_POLL_GAP_MS = 30_000;

export type UnreadThread = Pick<ThreadSummary, "id" | "title" | "kind">;
type State = { account: AccountHandle | null; threads: readonly UnreadThread[] };

const EMPTY: State = { account: null, threads: [] };
let state: State = EMPTY;
const listeners = new Set<() => void>();

/** A counter, not a clock: which happened first, a list call starting, a thread opening or a pick
 *  (coach-resume). Never reset: stamps are compared with ones held outside this store. */
let tick = 0;
/** When each opened thread's read answered: lists asked for before then are older than it. */
const openedAt = new Map<string, number>();
/** Threads opened whose read has not answered: their mark as the latest list saw it, or none. */
const pending = new Map<string, { thread: UnreadThread | null; sawUnread: boolean }>();
/** Each thread's newest opening attempt: only its read may settle the thread. */
const attempts = new Map<string, number>();
/** When the server dropped a thread's mark itself (clear or delete): lists asked for before then are
 *  older than it, for an opening read too. */
const droppedAt = new Map<string, number>();
/** Opened threads a later list found unread again: something new arrived in them. */
const deliveredAgain = new Set<string>();
/** The start stamp of the newest list applied. */
let lastApplied = -1;
let lastPollAt: number | null = null;
let inFlight: { account: AccountHandle; run: Promise<void> } | null = null;

type Deps = {
  /** The cheap check: how many threads are unread, or `null` when the coach is off. */
  count: (opts: CoachFetchOptions) => Promise<number | null>;
  list: (opts: CoachFetchOptions) => Promise<ThreadSummary[]>;
  now: () => number;
};
const DEFAULT_DEPS: Deps = { count: countUnreadThreads, list: listThreads, now: () => Date.now() };
let deps: Deps = DEFAULT_DEPS;

function set(next: State): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

function sameAccount(a: AccountHandle | null, b: AccountHandle | null): boolean {
  return !!a && !!b && a.userId === b.userId && a.epoch === b.epoch;
}

function sameThreads(a: readonly UnreadThread[], b: readonly UnreadThread[]): boolean {
  return a.length === b.length && a.every((thread, index) => thread.id === b[index].id
    && thread.title === b[index].title && thread.kind === b[index].kind);
}

/** A new account (or none) starts with no marks and may ask at once. */
function bindTo(account: AccountHandle | null): void {
  if (account ? sameAccount(state.account, account) : state.account === null) return;
  openedAt.clear();
  droppedAt.clear();
  pending.clear();
  attempts.clear();
  deliveredAgain.clear();
  lastApplied = -1;
  lastPollAt = null;
  inFlight = null;
  set(account ? { account, threads: [] } : EMPTY);
}

/** Stamp taken before a list call, so `noteThreads` can tell which opens it already saw. */
export function beginThreadRead(): number {
  return ++tick;
}

/**
 * Takes the marks from a full thread list (never a filtered one: a thread missing from it counts as
 * read). Ignored when it belongs to another account than the one bound now.
 */
export function noteThreads(threads: unknown, account: AccountHandle | null, startedAt: number): void {
  if (!account || !sameAccount(state.account, account) || !isCurrent(account)) return;
  if (!Array.isArray(threads) || startedAt <= lastApplied) return;
  lastApplied = startedAt;
  const unread: UnreadThread[] = [];
  for (const entry of pending.values()) entry.thread = null; // missing from the list: not unread
  for (const row of threads as Partial<ThreadSummary>[]) {
    if (!row || typeof row.id !== "string") continue;
    const thread = { id: row.id, title: typeof row.title === "string" ? row.title : null,
      kind: typeof row.kind === "string" ? row.kind : "chat" };
    if ((droppedAt.get(row.id) ?? -1) > startedAt) continue; // asked for before the server dropped it
    const opening = pending.get(row.id);
    if (opening) {
      // Landed while the read runs, whenever it was asked for: unread now may be a new review or a
      // clear not landed yet, so the read's success asks once more.
      opening.thread = row.unread === true ? thread : null;
      if (row.unread === true) opening.sawUnread = true;
      continue;
    }
    const opened = openedAt.get(row.id);
    if (row.unread !== true || (opened ?? -1) > startedAt) continue;
    if (opened !== undefined) deliveredAgain.add(row.id);
    unread.push(thread);
  }
  if (!sameThreads(unread, state.threads)) set({ ...state, threads: unread });
}

/**
 * The server dropped the thread's mark itself: its messages were cleared (which also clears the
 * unread mark) or it was deleted. The mark goes now; no list asked for before this brings it back,
 * and an opening read still running cannot restore it when it fails (its attempt is void).
 */
export function dropThreadMark(id: string): void {
  const at = ++tick;
  openedAt.set(id, at);
  droppedAt.set(id, at);
  deliveredAgain.delete(id);
  // An opening read still running can no longer put the mark back: its attempt is void.
  pending.delete(id);
  attempts.delete(id);
  if (state.threads.some((thread) => thread.id === id)) {
    set({ ...state, threads: state.threads.filter((thread) => thread.id !== id) });
  }
}

/**
 * Whether something new arrived in a thread after it was opened and read (a list asked for after
 * that read still marks it unread), as of now rather than the last render. A mark put back by a
 * failed read is not one: reopening would only fail again.
 */
export function isDeliveredAgain(id: string): boolean {
  return deliveredAgain.has(id) && state.threads.some((thread) => thread.id === id);
}

/**
 * The thread is on screen and its opening read has started: its mark hides now, pending that read.
 * Returns this attempt's token: only the newest attempt's read settles the thread, so a slow read
 * from an earlier opening cannot end a reopen's wait.
 */
export function beginThreadOpen(id: string): number {
  deliveredAgain.delete(id);
  const attempt = ++tick;
  attempts.set(id, attempt);
  if (!pending.has(id)) {
    pending.set(id, { thread: state.threads.find((thread) => thread.id === id) ?? null, sawUnread: false });
  }
  if (state.threads.some((thread) => thread.id === id)) {
    set({ ...state, threads: state.threads.filter((thread) => thread.id !== id) });
  }
  return attempt;
}

/**
 * The opening read of `attempt` answered: `ok`, the server cleared the mark, and no list asked for
 * before now can bring it back; a failure puts the mark back as the latest list saw it. A read from
 * an older attempt changes nothing.
 */
export function settleThreadOpen(id: string, ok: boolean, attempt: number): void {
  if (attempts.get(id) !== attempt) return;
  const opening = pending.get(id);
  pending.delete(id);
  if (ok) {
    openedAt.set(id, ++tick);
    if (state.threads.some((thread) => thread.id === id)) {
      set({ ...state, threads: state.threads.filter((thread) => thread.id !== id) });
    }
    if (opening?.sawUnread) void relist();
    return;
  }
  const back = opening?.thread;
  if (back && !state.threads.some((thread) => thread.id === id)) {
    set({ ...state, threads: [...state.threads, back] });
  }
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * The check behind every background ask: the count first; the full list (which threads) only when
 * the count says something is unread. A count of 0, or a coach that is off (404), clears the marks
 * through the same ordered path a list takes, as an empty list asked for when the count was.
 */
async function checkUnread(account: AccountHandle, background = false): Promise<void> {
  const counted = beginThreadRead();
  const count = await deps.count({ account });
  if (!count) { noteThreads([], account, counted); return; }
  // A background check that finds the app hidden by now leaves the list for the next return to
  // the foreground (a suspended PWA would hold the request), which may ask again at once.
  if (background && hidden()) { lastPollAt = null; return; }
  const listed = beginThreadRead();
  noteThreads(await deps.list({ account }), account, listed);
}

/** One check for the bound account, unless hidden, already running, or asked too recently. */
export function pollUnread(): Promise<void> {
  const account = state.account;
  if (!account || hidden() || !isCurrent(account)) return Promise.resolve();
  if (inFlight && sameAccount(inFlight.account, account)) return inFlight.run;
  const at = deps.now();
  if (lastPollAt !== null && at - lastPollAt < UNREAD_POLL_GAP_MS) return Promise.resolve();
  lastPollAt = at;
  const entry: { account: AccountHandle; run: Promise<void> } = { account, run: Promise.resolve() };
  inFlight = entry;
  entry.run = (async () => {
    try {
      await checkUnread(account, true);
    } catch {
      // Offline, refused, timed out or another account: the marks stay as they were.
    } finally {
      if (inFlight === entry) inFlight = null;
    }
  })();
  return entry.run;
}

/** One check outside the poll's gap: after a read that a list saw unread meanwhile. */
async function relist(): Promise<void> {
  const account = state.account;
  if (!account || !isCurrent(account)) return;
  try {
    await checkUnread(account);
  } catch {
    // The next poll asks again.
  }
}

let users = 0;
let stopTracking: (() => void) | null = null;

/** Follows the bound account and the app's visibility. Counted, so several mounts share one. */
export function startUnreadTracking(): () => void {
  users += 1;
  if (users === 1) {
    const ready = onAccountReady((account) => { bindTo(account); void pollUnread(); });
    const gone = onAccountGone(() => bindTo(null));
    const visible = () => { if (!hidden()) void pollUnread(); };
    document.addEventListener("visibilitychange", visible);
    stopTracking = () => { ready(); gone(); document.removeEventListener("visibilitychange", visible); };
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    users -= 1;
    if (users === 0) { stopTracking?.(); stopTracking = null; }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Called on every change to the marks. */
export const subscribeUnread = subscribe;
const snapshot = () => state.threads;
const serverSnapshot = () => EMPTY.threads;

/** The unread threads of the bound account. */
export function useUnreadThreads(): readonly UnreadThread[] {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** True while any thread of the bound account is unread. */
export function useHasUnread(): boolean {
  return useUnreadThreads().length > 0;
}

/** Mount once where the badge lives (the dock): asks on open and on each return to the foreground. */
export function useUnreadTracking(): void {
  useEffect(() => startUnreadTracking(), []);
}

/** The bubble's and the button's extra words while something is unread. */
export const UNREAD_SUFFIX = "new weekly review";

/** Tests only: swap the list call and the clock, and forget everything. */
export function resetUnreadForTests(next: Partial<Deps> = {}): void {
  deps = { ...DEFAULT_DEPS, ...next };
  stopTracking?.();
  stopTracking = null;
  users = 0;
  openedAt.clear();
  droppedAt.clear();
  pending.clear();
  attempts.clear();
  deliveredAgain.clear();
  lastApplied = -1;
  lastPollAt = null;
  inFlight = null;
  state = EMPTY;
  listeners.clear();
}
