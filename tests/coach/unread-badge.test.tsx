// @vitest-environment jsdom
/**
 * Where the weekly review's unread mark shows (2026-10-05): a dot on the dock's bubble and the
 * Chat tile, with "new weekly review" in their names; on /coach's Conversations button; on the
 * review's own row in Conversations ("New" for assistive tech). Opening the review clears every
 * mark once the server says its clear held (`cleared`); a review takes replies and is managed like a
 * chat, and clearing it drops its mark. A failed list leaves no mark and no error.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@/lib/coach-client";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import {
  beginThreadOpen, beginThreadRead, noteThreads, resetUnreadForTests, settleThreadOpen, startUnreadTracking,
} from "@/components/coach/unread-threads";
import { currentAccountOrNull } from "@/lib/device/account";
import type { SpeechHandlers } from "@/lib/coach/speech-api";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  /** The cheap unread count: 1 so the list follows, unless a test says otherwise. */
  count: vi.fn(), path: "/foods", mounts: 0,
  /** How the stand-in chat's opening read answers: as CoachShell reports it (`onThreadOpened`). */
  open: "ok" as "ok" | "fail" | "uncleared" | "hold",
  deleteThread: vi.fn(), clearThread: vi.fn(), renameThread: vi.fn(),
  /** Under "hold": answers the held opening read as a success, with the thread's kind. */
  settle: null as null | (() => void),
  getSession: vi.fn(async () => ({ data: { session: { user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } } } })),
}));
vi.mock("@/lib/coach/speech-api", () => ({
  micAvailable: () => true,
  startListening: (_handlers: SpeechHandlers) => ({ stop: vi.fn(), abort: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.path,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({ auth: {
  getSession: mocks.getSession,
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
} }) }));
vi.mock("@/lib/coach-client", async (original) => ({
  ...await original<typeof import("@/lib/coach-client")>(), listThreads: mocks.list,
}));
vi.mock("@/components/CaptureSheet", () => ({ default: () => null }));
vi.mock("@/lib/coach/threads-client", async (original) => ({
  ...await original<typeof import("@/lib/coach/threads-client")>(),
  deleteThread: mocks.deleteThread, clearThreadMessages: mocks.clearThread, renameThread: mocks.renameThread,
}));
vi.mock("@/components/CoachChat", async () => {
  const { useEffect, useState } = await import("react");
  function MockCoachChat(props: {
    threadId: string | null; header: React.ReactNode;
    onThreadOpened?: (id: string, cleared: boolean, kind?: string) => void;
  }) {
    const { threadId, header, onThreadOpened } = props;
    // Anything that would stop a reply in this thread (the retired read-only review).
    const blocked = (props as { readOnly?: unknown }).readOnly === true;
    const [mount] = useState(() => ++mocks.mounts);
    useEffect(() => {
      if (!threadId) return;
      const kind = threadId.startsWith("review") ? "weekly_review" : "chat";
      if (mocks.open === "hold") { mocks.settle = () => onThreadOpened?.(threadId, true, kind); return; }
      // "uncleared": the read answered but the server's unread clear write failed (`cleared: false`).
      const cleared = mocks.open === "ok";
      queueMicrotask(() => onThreadOpened?.(threadId, cleared, mocks.open === "fail" ? undefined : kind));
    }, [threadId, onThreadOpened]);
    return <div data-testid="chat" data-thread={threadId ?? "new"} data-mount={mount}
      data-replies={blocked ? "blocked" : "open"}>{header}</div>;
  }
  return { default: MockCoachChat };
});

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chat: ThreadSummary = { id: "chat-1", kind: "chat", title: "Lunch ideas",
  lastMessageAt: "2026-10-04T12:00:00Z", unread: false };
const review = (unread: boolean): ThreadSummary => ({ id: "review-1", kind: "weekly_review",
  title: "Weekly review", lastMessageAt: "2026-10-04T23:10:00Z", unread });

let stop: (() => void) | null = null;
/** The latest opening attempt's token (beginThreadOpen). */
let attempt = 0;

beforeEach(() => {
  mocks.list.mockReset();
  mocks.count.mockReset();
  mocks.count.mockResolvedValue(1);
  mocks.path = "/foods";
  mocks.mounts = 0;
  mocks.open = "ok";
  mocks.deleteThread.mockReset(); mocks.clearThread.mockReset(); mocks.renameThread.mockReset();
  mocks.settle = null;
  localStorage.clear();
  unbindAccount();
  resetUnreadForTests({ list: mocks.list, count: mocks.count });
});
afterEach(() => {
  cleanup();
  stop?.();
  stop = null;
  unbindAccount();
});

describe("the dock's bubble", () => {
  async function renderDock() {
    const { default: TabBar } = await import("@/components/TabBar");
    const { CapabilitiesProvider } = await import("@/components/CapabilitiesProvider");
    render(<CapabilitiesProvider value={{ coach: true, scan: false, captureMethods: ["photo"] }}>
      <TabBar />
    </CapabilitiesProvider>);
  }

  it("carries a dot and says so while a review is unread, and drops both once it is opened", async () => {
    mocks.list.mockResolvedValue([chat, review(true)]);
    await renderDock();
    act(() => markAccountReady(bindAccount(A)));
    const bubble = await screen.findByRole("button", { name: "Ask Sasha, new weekly review" });
    expect(bubble.querySelector("[data-unread-dot]")).not.toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(1);

    // The Chat tile in the attach tray says it too.
    fireEvent.click(bubble);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.getByRole("button", { name: "Open chat, new weekly review" })).toBeTruthy();

    act(() => { attempt = beginThreadOpen("review-1"); settleThreadOpen("review-1", true, attempt); });
    expect(screen.getByRole("button", { name: "Open chat" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector("[data-unread-dot]")).toBeNull());
  });

  it("shows nothing while every thread is read", async () => {
    mocks.list.mockResolvedValue([chat, review(false)]);
    await renderDock();
    act(() => markAccountReady(bindAccount(A)));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Ask Sasha" })).toBeTruthy();
    expect(document.querySelector("[data-unread-dot]")).toBeNull();
  });

  it("stays as it was, with no error, when the list call fails", async () => {
    mocks.list.mockRejectedValue(new Error("offline"));
    await renderDock();
    act(() => markAccountReady(bindAccount(A)));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Ask Sasha" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows no badge and no error when the coach is off (the count answers 404)", async () => {
    mocks.count.mockResolvedValue(null);
    await renderDock();
    act(() => markAccountReady(bindAccount(A)));
    await waitFor(() => expect(mocks.count).toHaveBeenCalledTimes(1));
    expect(mocks.list).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ask Sasha" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears on sign-out", async () => {
    mocks.list.mockResolvedValue([review(true)]);
    await renderDock();
    act(() => markAccountReady(bindAccount(A)));
    await screen.findByRole("button", { name: "Ask Sasha, new weekly review" });
    act(() => { unbindAccount(); });
    expect(screen.getByRole("button", { name: "Ask Sasha" })).toBeTruthy();
  });
});

describe("the Conversations list on /coach", () => {
  async function renderCoach() {
    const { default: CoachScreen } = await import("@/app/coach/CoachScreen");
    const { CapabilitiesProvider } = await import("@/components/CapabilitiesProvider");
    render(<CapabilitiesProvider value={{ coach: true, scan: false, captureMethods: [] }}>
      <CoachScreen />
    </CapabilitiesProvider>);
  }

  // As in the app: the dock's tracking has already asked once this account opened.
  beforeEach(async () => {
    mocks.list.mockResolvedValue([chat, review(true)]);
    act(() => markAccountReady(bindAccount(A)));
    stop = startUnreadTracking();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  });

  it("marks the review's own row, and opening it clears the mark", async () => {
    await renderCoach();
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("chat-1"));
    const conversations = await screen.findByRole("button", { name: /^Conversations.*new weekly review$/ });
    expect(conversations.querySelector("[data-unread-dot]")).not.toBeNull();

    fireEvent.click(conversations);
    const row = await screen.findByRole("button", { name: /^New:\s*Weekly review/ });
    await waitFor(() => expect(row.hasAttribute("disabled")).toBe(false));
    expect(row.querySelector("[data-unread-dot]")).not.toBeNull();
    // Managed like a chat: its own "…" menu; and the chat row has no mark.
    expect(screen.getByRole("button", { name: "More for Weekly review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Lunch ideas/ }).querySelector("[data-unread-dot]")).toBeNull();

    fireEvent.click(row);
    expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("review-1");
    expect(screen.queryByText(/read only/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^Conversations, 1 saved$/ })).toBeTruthy();
  });

  it("offers an unread review from any chat, and Read it opens it", async () => {
    await renderCoach();
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("chat-1"));
    const notice = await screen.findByText("Your weekly review is ready.");
    const readIt = within(notice.closest(".notice") as HTMLElement).getByRole("button", { name: "Read it" });
    readIt.focus();
    fireEvent.click(readIt);
    expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("review-1");
    // The button it was pressed on is gone: focus is on the review's own heading, not the document.
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Weekly review" }));
    expect(screen.queryByText("Your weekly review is ready.")).toBeNull();
    // A review takes replies: nothing blocks the composer.
    expect(screen.getByTestId("chat").getAttribute("data-replies")).toBe("open");
  });

  it("puts the mark back when the review's opening read fails", async () => {
    mocks.open = "fail";
    await renderCoach();
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("chat-1"));
    fireEvent.click(await screen.findByRole("button", { name: /^Conversations.*new weekly review$/ }));
    const row = await screen.findByRole("button", { name: /^New:\s*Weekly review/ });
    await waitFor(() => expect(row.hasAttribute("disabled")).toBe(false));
    fireEvent.click(row);
    expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("review-1");
    await screen.findByRole("button", { name: "Conversations, 1 saved, new weekly review" });
  });

  it("keeps the mark hidden while the opening read runs, whatever a list says meanwhile", async () => {
    mocks.open = "hold";
    await renderCoach();
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("chat-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Read it" }));
    expect(screen.getByRole("button", { name: "Conversations, 1 saved" })).toBeTruthy();
    act(() => noteThreads([chat, review(true)], currentAccountOrNull(), beginThreadRead()));
    expect(screen.getByRole("button", { name: "Conversations, 1 saved" })).toBeTruthy();
  });

  it("reloads the open review when a new one is delivered into it", async () => {
    await renderCoach();
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("chat-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Read it" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Conversations, 1 saved" })).toBeTruthy());
    const before = screen.getByTestId("chat").getAttribute("data-mount");
    await act(async () => { await Promise.resolve(); });
    // The next poll after the open: a new review landed in the same thread.
    act(() => noteThreads([chat, review(true)], currentAccountOrNull(), beginThreadRead()));
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-mount")).not.toBe(before));
    expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("review-1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Conversations, 1 saved" })).toBeTruthy());
  });

  it("lists the review from the first thread list, before any refresh", async () => {
    await renderCoach();
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("chat-1"));
    mocks.list.mockRejectedValue(new Error("offline"));
    fireEvent.click(await screen.findByRole("button", { name: /^Conversations/ }));
    await screen.findByText("Could not refresh conversations.");
    expect(screen.getByRole("button", { name: /^(New:\s*)?Weekly review/ })).toBeTruthy();
  });

  it("reloads the review when a list during its read saw it unread and the check after still does", async () => {
    mocks.open = "hold";
    await renderCoach();
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("chat-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Read it" }));
    const before = screen.getByTestId("chat").getAttribute("data-mount");
    // A new review lands while the transcript's read is still running.
    act(() => noteThreads([chat, review(true)], currentAccountOrNull(), beginThreadRead()));
    mocks.open = "ok";
    await act(async () => { mocks.settle?.(); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-mount")).not.toBe(before));
    expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("review-1");
  });

  it("knows a resumed review from its own read when no list can be read", async () => {
    localStorage.setItem(`smc:coach:current:${A}`, "review-1");
    mocks.list.mockRejectedValue(new Error("offline"));
    await renderCoach();
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("review-1"));
    await screen.findByRole("heading", { name: "Weekly review" });
  });

  it("keeps the dot when the read answered but the server's clear failed (cleared: false)", async () => {
    mocks.open = "uncleared";
    await renderCoach();
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("chat-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Read it" }));
    expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("review-1");
    await screen.findByRole("button", { name: "Conversations, 1 saved, new weekly review" });
  });

  describe("managing a review like a chat", () => {
    async function openMenu() {
      await renderCoach();
      await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("chat-1"));
      fireEvent.click(await screen.findByRole("button", { name: /^Conversations/ }));
      const more = await screen.findByRole("button", { name: "More for Weekly review" });
      await waitFor(() => expect(more.hasAttribute("disabled")).toBe(false));
      fireEvent.click(more);
      return screen.getByRole("group", { name: "Actions for Weekly review" });
    }

    it("renames it", async () => {
      mocks.renameThread.mockResolvedValue({ id: "review-1", title: "Sunday notes", kind: "weekly_review",
        lastMessageAt: null });
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("button", { name: "Rename" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Chat name" }), { target: { value: "Sunday notes" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("button", { name: /^(New:\s*)?Sunday notes/ });
      expect(mocks.renameThread).toHaveBeenCalledWith("review-1", "Sunday notes");
    });

    it("clears it, and clearing drops its dot", async () => {
      mocks.clearThread.mockResolvedValue(undefined);
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("button", { name: "Clear messages" }));
      fireEvent.click(within(menu).getByRole("button", { name: "Clear for good" }));
      await waitFor(() => expect(mocks.clearThread).toHaveBeenCalledWith("review-1"));
      await screen.findByRole("button", { name: "Conversations, 1 saved" });
      expect(screen.getByRole("button", { name: /^Weekly review/ })).toBeTruthy(); // no "New"
      await waitFor(() => expect(document.querySelector("[data-unread-dot]")).toBeNull()); // shrinks away
    });

    it("deletes it", async () => {
      mocks.deleteThread.mockResolvedValue("deleted");
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("button", { name: "Delete" }));
      fireEvent.click(within(menu).getByRole("button", { name: "Delete for good" }));
      await waitFor(() => expect(mocks.deleteThread).toHaveBeenCalledWith("review-1"));
      await waitFor(() => expect(screen.queryByRole("button", { name: /^(New:\s*)?Weekly review/ })).toBeNull());
      expect(screen.getByRole("button", { name: "Conversations, 1 saved" })).toBeTruthy();
    });
  });

  it("never lets an older first list replace a newer refresh", async () => {
    let first: (rows: ThreadSummary[]) => void = () => {};
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }));
    const newer: ThreadSummary = { id: "chat-2", kind: "chat", title: "Dinner plans",
      lastMessageAt: "2026-10-05T08:00:00Z", unread: false };
    mocks.list.mockResolvedValueOnce([newer, chat, review(true)]);
    await renderCoach();
    fireEvent.click(await screen.findByRole("button", { name: /^Conversations/ }));
    await screen.findByRole("button", { name: /^Dinner plans/ });
    await act(async () => { first([chat]); await Promise.resolve(); });
    expect(screen.getByRole("button", { name: /^Dinner plans/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^(New:\s*)?Weekly review/ })).toBeTruthy();
  });
});
