// @vitest-environment jsdom
/**
 * The weekly review's unread mark on the phone (components/coach/unread-threads.ts): asked for when
 * the app opens and on each return to the foreground, never while hidden and never twice inside
 * 30 s; per account; cleared at once on open; a failed list changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@/lib/coach-client";
import {
  bindAccount, currentAccountOrNull, markAccountReady, unbindAccount,
} from "@/lib/device/account";
import {
  UNREAD_POLL_GAP_MS, beginThreadOpen, beginThreadRead, dropThreadMark, isDeliveredAgain, noteThreads, pollUnread, resetUnreadForTests,
  settleThreadOpen, startUnreadTracking, useUnreadThreads,
} from "@/components/coach/unread-threads";
import { act, cleanup, renderHook } from "@testing-library/react";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const review = (unread: boolean, id = "review-1"): ThreadSummary =>
  ({ id, kind: "weekly_review", title: "Weekly review", lastMessageAt: "2026-10-04T23:10:00Z", unread });
const chat: ThreadSummary = { id: "chat-1", kind: "chat", title: "Lunch", lastMessageAt: null, unread: false };

let now = 1_000_000;
const list = vi.fn<(opts: unknown) => Promise<ThreadSummary[]>>();
/** The cheap check (GET /api/coach/threads/unread): 1 unless a test says otherwise, so lists follow. */
const count = vi.fn<(opts: unknown) => Promise<number | null>>();
let visibility: DocumentVisibilityState = "visible";
let stop: (() => void) | null = null;
/** The latest opening attempt's token (beginThreadOpen). */
let attempt = 0;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function signIn(userId: string) {
  markAccountReady(bindAccount(userId));
}

const unreadIds = () => {
  const { result } = renderHook(() => useUnreadThreads());
  return result.current.map((thread) => thread.id);
};

/** Lets the list call's promise settle. */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  now = 1_000_000;
  list.mockReset();
  count.mockReset();
  count.mockResolvedValue(1);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  unbindAccount();
  resetUnreadForTests({ count, list, now: () => now });
});
afterEach(() => {
  cleanup();
  stop?.();
  stop = null;
  unbindAccount();
  vi.restoreAllMocks();
});

describe("asking for unread threads", () => {
  it("asks once when the account opens, with that account's handle", async () => {
    list.mockResolvedValue([review(true), chat]);
    stop = startUnreadTracking();
    expect(list).not.toHaveBeenCalled();
    signIn(A);
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toEqual({ account: currentAccountOrNull() });
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("asks again on a return to the foreground, at most once per 30 s, never while hidden", async () => {
    list.mockResolvedValue([review(false)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    expect(list).toHaveBeenCalledTimes(1);

    now += 5_000;
    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(list).toHaveBeenCalledTimes(1); // inside the gap

    now += UNREAD_POLL_GAP_MS;
    setVisibility("hidden");
    await settle();
    expect(list).toHaveBeenCalledTimes(1); // hidden: never
    await pollUnread();
    expect(list).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await settle();
    expect(list).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not start a second call while one is running", async () => {
    let answer: (rows: ThreadSummary[]) => void = () => {};
    list.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    signIn(A);
    stop = startUnreadTracking();
    now += UNREAD_POLL_GAP_MS * 2;
    void pollUnread();
    void pollUnread();
    await settle(); // the count answers first, then the list starts
    expect(count).toHaveBeenCalledTimes(1); // the first check is still running: both calls join it
    expect(list).toHaveBeenCalledTimes(1);
    answer([review(true)]);
    await settle();
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("shares one listener between several mounts", async () => {
    list.mockResolvedValue([]);
    signIn(A);
    const first = startUnreadTracking();
    const second = startUnreadTracking();
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    first();
    now += UNREAD_POLL_GAP_MS;
    setVisibility("visible");
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    second();
    now += UNREAD_POLL_GAP_MS;
    setVisibility("visible");
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("the marks", () => {
  it("keep their state when a list call fails, and never throw", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    expect(unreadIds()).toEqual(["review-1"]);

    list.mockRejectedValueOnce(new Error("offline"));
    now += UNREAD_POLL_GAP_MS;
    await expect(pollUnread()).resolves.toBeUndefined();
    expect(unreadIds()).toEqual(["review-1"]);

    list.mockResolvedValueOnce({ error: "bad" } as unknown as ThreadSummary[]);
    now += UNREAD_POLL_GAP_MS;
    await pollUnread();
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("clear at once on open, and a list already in flight cannot bring the mark back", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();

    let answer: (rows: ThreadSummary[]) => void = () => {};
    list.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    now += UNREAD_POLL_GAP_MS;
    const running = pollUnread();
    await settle(); // the list is asked for before the open
    act(() => { attempt = beginThreadOpen("review-1"); });
    expect(unreadIds()).toEqual([]);
    act(() => settleThreadOpen("review-1", true, attempt));
    answer([review(true)]); // read before the open landed on the server
    await running;
    expect(unreadIds()).toEqual([]);

    // A list asked for after the open is the server's word: its clear did not land.
    list.mockResolvedValueOnce([review(true)]);
    now += UNREAD_POLL_GAP_MS;
    await pollUnread();
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("apply in the order they were asked for, so an older answer arriving last changes nothing", async () => {
    list.mockResolvedValueOnce([]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    const account = currentAccountOrNull();

    let older: (rows: ThreadSummary[]) => void = () => {};
    list.mockImplementationOnce(() => new Promise((resolve) => { older = resolve; }));
    now += UNREAD_POLL_GAP_MS;
    const running = pollUnread(); // asked first, answers last
    await settle();
    act(() => noteThreads([review(true)], account, beginThreadRead())); // a newer Conversations read
    expect(unreadIds()).toEqual(["review-1"]);
    older([review(false)]);
    await running;
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("stay hidden while the opening read runs, and come back when it fails", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    const account = currentAccountOrNull();

    act(() => { attempt = beginThreadOpen("review-1"); });
    expect(unreadIds()).toEqual([]);
    // A list answered mid-read still says unread: the mark stays hidden while the read runs.
    act(() => noteThreads([review(true)], account, beginThreadRead()));
    expect(unreadIds()).toEqual([]);
    // The read failed: the server never cleared it, so the mark is back.
    act(() => settleThreadOpen("review-1", false, attempt));
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("stay read after a failed opening read when a list during it said read", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    const account = currentAccountOrNull();
    act(() => { attempt = beginThreadOpen("review-1"); });
    act(() => noteThreads([review(false)], account, beginThreadRead()));
    act(() => settleThreadOpen("review-1", false, attempt));
    expect(unreadIds()).toEqual([]);
  });

  it("ask once more after a read that a list saw unread meanwhile, and find a new delivery", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    const account = currentAccountOrNull();
    act(() => { attempt = beginThreadOpen("review-1"); });
    // Asked during the read: a new review, or the read's clear not landed yet? It cannot tell.
    act(() => noteThreads([review(true)], account, beginThreadRead()));
    list.mockResolvedValueOnce([review(true)]); // asked after the read: still unread, so new
    act(() => settleThreadOpen("review-1", true, attempt));
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(unreadIds()).toEqual(["review-1"]);
    expect(isDeliveredAgain("review-1")).toBe(true);
  });

  it("ask once more after a read when a list asked for before it lands during it, still unread", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    const account = currentAccountOrNull();
    const askedBefore = beginThreadRead(); // a Conversations list asked for before the open
    act(() => { attempt = beginThreadOpen("review-1"); });
    act(() => noteThreads([review(true)], account, askedBefore)); // lands while the read runs
    list.mockResolvedValueOnce([review(true)]);
    act(() => settleThreadOpen("review-1", true, attempt));
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(isDeliveredAgain("review-1")).toBe(true);
  });

  it("settle only from the newest opening: a slow first read cannot end a reopen's wait", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    let first = 0;
    act(() => { first = beginThreadOpen("review-1"); });
    act(() => { attempt = beginThreadOpen("review-1"); }); // reopened before the first read answered
    act(() => settleThreadOpen("review-1", true, first)); // the stale read answers
    act(() => noteThreads([review(true)], currentAccountOrNull(), beginThreadRead()));
    expect(unreadIds()).toEqual([]); // still pending on the reopen's read
    act(() => settleThreadOpen("review-1", false, attempt)); // the reopen's read failed
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("do not ask again after a read when no list during it saw the thread unread", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    act(() => { attempt = beginThreadOpen("review-1"); });
    act(() => noteThreads([review(false)], currentAccountOrNull(), beginThreadRead()));
    act(() => settleThreadOpen("review-1", true, attempt));
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    expect(unreadIds()).toEqual([]);
  });

  it("tell a new delivery into an opened thread from a mark a failed read put back", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    const account = currentAccountOrNull();
    act(() => { attempt = beginThreadOpen("review-1"); settleThreadOpen("review-1", false, attempt); });
    expect(isDeliveredAgain("review-1")).toBe(false); // put back, not new
    act(() => { attempt = beginThreadOpen("review-1"); settleThreadOpen("review-1", true, attempt); });
    act(() => noteThreads([review(true)], account, beginThreadRead())); // asked after the read
    expect(isDeliveredAgain("review-1")).toBe(true);
    act(() => { attempt = beginThreadOpen("review-1"); }); // the reload reads it again
    expect(isDeliveredAgain("review-1")).toBe(false);
  });

  it("take a full list from elsewhere (the Conversations list) for the bound account only", async () => {
    list.mockResolvedValue([]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    const account = currentAccountOrNull();
    act(() => noteThreads([review(true, "r-2")], account, beginThreadRead()));
    expect(unreadIds()).toEqual(["r-2"]);
    act(() => noteThreads([review(true, "r-3")], { userId: B, epoch: 999 }, beginThreadRead()));
    expect(unreadIds()).toEqual(["r-2"]);
  });

  it("reset on sign-out and on an account change, and a late answer for the old account is dropped", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    expect(unreadIds()).toEqual(["review-1"]);

    act(() => { unbindAccount(); });
    expect(unreadIds()).toEqual([]);

    let late: (rows: ThreadSummary[]) => void = () => {};
    list.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
    act(() => signIn(A));
    await settle();
    expect(list).toHaveBeenCalledTimes(2); // a new sign-in asks at once, inside the gap
    list.mockResolvedValueOnce([chat]);
    act(() => signIn(B));
    await settle();
    expect(list).toHaveBeenCalledTimes(3);
    late([review(true)]);
    await settle();
    expect(unreadIds()).toEqual([]);
  });
});

describe("the cheap count", () => {
  it("lists nothing when the count is 0, and clears marks a list left", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    expect(unreadIds()).toEqual(["review-1"]);

    count.mockResolvedValueOnce(0);
    now += UNREAD_POLL_GAP_MS;
    await pollUnread();
    expect(count).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
    expect(unreadIds()).toEqual([]);
  });

  it("lists once when the count is above 0", async () => {
    count.mockResolvedValue(1);
    list.mockResolvedValue([review(true), chat]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    expect(count).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toEqual({ account: currentAccountOrNull() });
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("leaves the list for the next foreground when the app is hidden by the time the count answers", async () => {
    let answer: (n: number) => void = () => undefined;
    count.mockImplementationOnce(() => new Promise<number>((resolve) => { answer = resolve; }));
    list.mockResolvedValue([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    setVisibility("hidden");
    answer(1);
    await settle();
    expect(list).not.toHaveBeenCalled();
    // Back in the foreground at once, inside the usual gap: the skipped list is asked for now.
    setVisibility("visible");
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("is silent when the coach is off (404): no list, no badge, no error", async () => {
    count.mockResolvedValue(null);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    expect(count).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(unreadIds()).toEqual([]);
  });

  it("keeps the marks and lists nothing when the count fails", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    count.mockRejectedValueOnce(new Error("offline"));
    now += UNREAD_POLL_GAP_MS;
    await expect(pollUnread()).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("keeps the request order: a 0 asked for before a newer list cannot clear what it found", async () => {
    count.mockResolvedValueOnce(0);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    let zero: (value: number) => void = () => {};
    count.mockImplementationOnce(() => new Promise((resolve) => { zero = resolve; }));
    now += UNREAD_POLL_GAP_MS;
    const running = pollUnread(); // counted first, answers last
    act(() => noteThreads([review(true)], currentAccountOrNull(), beginThreadRead())); // Conversations
    zero(0);
    await running;
    expect(unreadIds()).toEqual(["review-1"]);
  });
});

describe("a mark the server dropped itself (clear or delete)", () => {
  it("stays gone when an older list lands and the opening read then fails", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    const account = currentAccountOrNull();
    act(() => { attempt = beginThreadOpen("review-1"); }); // the review's read is running
    const askedBefore = beginThreadRead(); // a list asked for before "Clear messages" landed
    act(() => dropThreadMark("review-1")); // Clear messages succeeded: the server cleared it
    act(() => noteThreads([review(true)], account, askedBefore)); // the older list lands
    act(() => settleThreadOpen("review-1", false, attempt)); // then the read fails
    expect(unreadIds()).toEqual([]);
  });

  it("stays gone through a reopen when a list asked for before the drop lands during it", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    const account = currentAccountOrNull();
    const askedBefore = beginThreadRead();
    act(() => dropThreadMark("review-1"));
    act(() => { attempt = beginThreadOpen("review-1"); }); // the cleared review reloads
    act(() => noteThreads([review(true)], account, askedBefore));
    act(() => settleThreadOpen("review-1", false, attempt));
    expect(unreadIds()).toEqual([]);
  });

  it("voids the opening read that was running: a new review after the drop shows, and the old read settles nothing", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    act(() => { attempt = beginThreadOpen("review-1"); });
    act(() => dropThreadMark("review-1"));
    act(() => noteThreads([review(true)], currentAccountOrNull(), beginThreadRead())); // a new review
    expect(unreadIds()).toEqual(["review-1"]); // not hidden behind the void read
    act(() => settleThreadOpen("review-1", true, attempt)); // the old read answers late
    expect(unreadIds()).toEqual(["review-1"]);
  });

  it("comes back for a list asked for after the drop: something new arrived", async () => {
    list.mockResolvedValueOnce([review(true)]);
    signIn(A);
    stop = startUnreadTracking();
    await settle();
    act(() => dropThreadMark("review-1"));
    act(() => noteThreads([review(true)], currentAccountOrNull(), beginThreadRead()));
    expect(unreadIds()).toEqual(["review-1"]);
  });
});
