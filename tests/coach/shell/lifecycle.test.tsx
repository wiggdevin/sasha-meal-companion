// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CoachShell from "@/components/coach/CoachShell";
import { COACH_DOCK_STATE_EVENT, type DockComposerState } from "@/components/coach/use-dock-composer-state";
import { HISTORY_PAGE_SIZE } from "@/lib/coach/thread-history";
import type { CoachTurnResponse } from "@/lib/coach/types";

// A CI shard under load can take past the 1 s default to render, restore and fail a turn.
const SLOW = { timeout: 3000 };

/** The pending/success glow CoachShell broadcasts for the dock's one send control to carry (the
 *  page composer that used to show it directly is gone); CoachShell itself renders no such button. */
function dockStates(): { seen: DockComposerState[]; stop: () => void } {
  const seen: DockComposerState[] = [];
  const receive = (event: Event) => seen.push((event as CustomEvent<DockComposerState>).detail);
  window.addEventListener(COACH_DOCK_STATE_EVENT, receive);
  return { seen, stop: () => window.removeEventListener(COACH_DOCK_STATE_EVENT, receive) };
}

const mocks = vi.hoisted(() => ({
  fetchOlder: vi.fn(),
  getThread: vi.fn(),
  postAttachmentTurn: vi.fn(),
  postTurn: vi.fn(),
}));

vi.mock("@/lib/coach-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coach-client")>();
  return {
    ...actual,
    fetchOlder: mocks.fetchOlder,
    getThread: mocks.getThread,
    postAttachmentTurn: mocks.postAttachmentTurn,
    postTurn: mocks.postTurn,
    readCache: () => ({
      messages: [{ id: "cached-1", role: "assistant", content: "Cached", seq: 1 }],
      actions: [],
    }),
    writeCache: vi.fn(),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockScrollGeometry(scrollHeight = 600, clientHeight = 300) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(clientHeight);
}

/** The dock is the one way into a turn now (CoachShell owns no composer of its own); this is the
 *  same event the dock's ask field and `useCoachDockSubmit` already use in production. */
function sendViaDock(text: string): void {
  act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit", { detail: { text } })));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.fetchOlder.mockReset();
  mocks.getThread.mockReset();
  mocks.postAttachmentTurn.mockReset();
  mocks.postTurn.mockReset();
});

describe("coach shell lifecycle", () => {
  it("sends a query submitted from the selected Sasha dock field", async () => {
    mocks.postTurn.mockReturnValue(new Promise(() => {}));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000009");
    render(<CoachShell userId="user-1" threadId={null}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);

    act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit", {
      detail: { text: "Swap bread for a tortilla" },
    })));

    await waitFor(() => expect(mocks.postTurn).toHaveBeenCalledTimes(1));
    expect(mocks.postTurn.mock.calls[0][0]).toMatchObject({
      threadId: null,
      messageId: "3f1b1a2c-0000-4000-8000-000000000009",
      text: "Swap bread for a tortilla",
    });
  });

  it("follows the bottom through open, restore, a dock send, and the reply", async () => {
    mockScrollGeometry();
    const restored = deferred<Awaited<ReturnType<typeof import("@/lib/coach-client")["getThread"]>>>();
    const replied = deferred<CoachTurnResponse>();
    mocks.getThread.mockReturnValue(restored.promise);
    mocks.postTurn.mockReturnValue(replied.promise);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000010");

    const view = render(<CoachShell userId="user-1" threadId="thread-1"
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    expect(mocks.getThread).toHaveBeenCalledWith("thread-1", { limit: HISTORY_PAGE_SIZE });
    const scroller = view.getByLabelText("Conversation");
    expect(scroller.scrollTop).toBe(600);

    scroller.scrollTop = 250;
    await act(async () => restored.resolve({
      thread: { id: "thread-1", title: null, kind: "chat", lastMessageAt: null },
      messages: [{ id: "server-1", role: "assistant", content: "Restored", seq: 1 }],
      cleared: true,
    }));
    expect(scroller.scrollTop).toBe(600);

    scroller.scrollTop = 250;
    sendViaDock("Hello");
    expect(view.getByText("Thinking…")).not.toBeNull();
    expect(scroller.scrollTop).toBe(600);

    scroller.scrollTop = 250;
    await act(async () => replied.resolve({
      threadId: "thread-1",
      suggestions: [], actions: [], draft: null, deflected: false, toolsUsed: [],
      messages: [
        { id: "user-2", role: "user", content: "Hello", seq: 2 },
        { id: "assistant-3", role: "assistant", content: "Hi", seq: 3 },
      ],
      model: { provider: "gemini", modelId: "test" },
    }));
    expect(view.getByText("Hi")).not.toBeNull();
    expect(scroller.scrollTop).toBe(600);
  });

  it("renders toolbar and message extras without remounting the toolbar for an attachment turn", async () => {
    const replied = deferred<CoachTurnResponse>();
    mocks.postAttachmentTurn.mockReturnValue(replied.promise);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000010");
    const attachment = {
      kind: "capture" as const, v: 1 as const, method: "photo" as const,
      mediaPath: "media/3f1b1a2c-0000-4000-8000-000000000011/3f1b1a2c-0000-4000-8000-000000000012.jpg",
      localDate: "2026-09-19",
    };
    const view = render(<CoachShell userId="user-1" threadId={null}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined}
      toolbar={(controls) => <button type="button"
        onClick={() => controls.sendAttachment(attachment, "Photo attached")}>Attach photo</button>}
      renderExtras={(message) => <span>Extra for {message.id}</span>} />);
    const toolbar = view.getByRole("button", { name: "Attach photo" });

    fireEvent.click(toolbar);

    expect(view.getByText("Photo attached")).not.toBeNull();
    expect(view.getByText("Extra for 3f1b1a2c-0000-4000-8000-000000000010")).not.toBeNull();
    expect(view.getByRole("button", { name: "Attach photo" })).toBe(toolbar);

    await act(async () => replied.resolve({
      threadId: "thread-1", suggestions: [], actions: [], draft: null, deflected: false,
      toolsUsed: [],
      messages: [{ id: "assistant-2", role: "assistant", content: "I found it.", seq: 2 }],
      model: { provider: "gemini", modelId: "test" },
    }));
    expect(view.getByText("Extra for assistant-2")).not.toBeNull();
    expect(view.getByRole("button", { name: "Attach photo" })).toBe(toolbar);
  });

  it("shows a retry row when older history fails and retries from it", async () => {
    mocks.getThread.mockResolvedValue({
      thread: { id: "thread-1", title: null, kind: "chat", lastMessageAt: null },
      messages: Array.from({ length: 50 }, (_, index) => ({
        id: `message-${index + 51}`, role: "assistant" as const,
        content: `Message ${index + 51}`, seq: index + 51,
      })),
    });
    mocks.fetchOlder.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({
      thread: { id: "thread-1", title: null, kind: "chat", lastMessageAt: null },
      messages: [],
    });
    const view = render(<CoachShell userId="user-1" threadId="thread-1"
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    const scroller = await view.findByLabelText("Conversation");
    await view.findByText("Message 100");

    fireEvent.scroll(scroller);

    const alert = await view.findByRole("alert");
    expect(mocks.fetchOlder).toHaveBeenNthCalledWith(
      1, "thread-1", 51, HISTORY_PAGE_SIZE,
    );
    expect(alert.textContent).toContain("Couldn’t load earlier messages —");
    expect(alert.compareDocumentPosition(view.getByText("Message 51"))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.fetchOlder).toHaveBeenCalledTimes(2));
    expect(view.queryByText("Couldn’t load earlier messages —")).toBeNull();
  });

  it("preserves the reader through an in-flight reply and keeps loading full older pages", async () => {
    mocks.getThread.mockResolvedValue({
      thread: { id: "thread-1", title: null, kind: "chat", lastMessageAt: null },
      messages: Array.from({ length: 50 }, (_, index) => ({
        id: `message-${index + 101}`, role: "assistant" as const,
        content: `Message ${index + 101}`, seq: index + 101,
      })),
    });
    const firstPage = deferred<Awaited<ReturnType<typeof import("@/lib/coach-client")["fetchOlder"]>>>();
    const secondPage = deferred<Awaited<ReturnType<typeof import("@/lib/coach-client")["fetchOlder"]>>>();
    const firstReply = deferred<CoachTurnResponse>();
    const secondReply = deferred<CoachTurnResponse>();
    mocks.fetchOlder.mockReturnValueOnce(firstPage.promise).mockReturnValueOnce(secondPage.promise);
    mocks.postTurn.mockReturnValueOnce(firstReply.promise).mockReturnValueOnce(secondReply.promise);
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("3f1b1a2c-0000-4000-8000-000000000020")
      .mockReturnValueOnce("3f1b1a2c-0000-4000-8000-000000000023");
    const view = render(<CoachShell userId="user-1" threadId="thread-1"
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    const scroller = await view.findByLabelText("Conversation");
    let scrollHeight = 300;
    let scrollTop = 100;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 200 },
      scrollTop: { configurable: true, get: () => scrollTop,
        set: (value: number) => { scrollTop = value; } },
    });
    await view.findByText("Message 150");

    fireEvent.scroll(scroller);
    expect(mocks.fetchOlder).toHaveBeenCalledTimes(1);
    fireEvent.scroll(scroller);
    expect(mocks.fetchOlder).toHaveBeenCalledTimes(1);

    sendViaDock("While loading");
    expect(scrollTop).toBe(100);
    scrollHeight = 320;
    await act(async () => firstReply.resolve({
      threadId: "thread-1", suggestions: [], actions: [], draft: null, deflected: false,
      toolsUsed: [], model: { provider: "gemini", modelId: "test" },
      messages: [
        { id: "3f1b1a2c-0000-4000-8000-000000000020", role: "user",
          content: "While loading", seq: 151 },
        { id: "assistant-152", role: "assistant", content: "Still here", seq: 152 },
      ],
    }));
    expect(scrollTop).toBe(100);

    scrollHeight = 370;
    await act(async () => firstPage.resolve({
      thread: { id: "thread-1", title: null, kind: "chat", lastMessageAt: null },
      messages: Array.from({ length: 50 }, (_, index) => ({
        id: `message-${index + 51}`, role: "assistant" as const,
        content: `Message ${index + 51}`, seq: index + 51,
      })),
      cleared: true,
    }));
    await waitFor(() => expect(mocks.fetchOlder).toHaveBeenCalledTimes(2));
    expect(mocks.fetchOlder).toHaveBeenNthCalledWith(
      2, "thread-1", 51, HISTORY_PAGE_SIZE,
    );

    scrollHeight = 380;
    await act(async () => secondPage.resolve({
      thread: { id: "thread-1", title: null, kind: "chat", lastMessageAt: null },
      messages: [{ id: "message-50", role: "assistant", content: "Message 50", seq: 50 }],
      cleared: true,
    }));
    await waitFor(() => expect(view.getByText("Message 50")).not.toBeNull());
    expect(mocks.fetchOlder).toHaveBeenCalledTimes(2);

    scrollTop = 180;
    fireEvent.scroll(scroller);
    sendViaDock("Pinned now");
    expect(scrollTop).toBe(380);
    scrollHeight = 400;
    await act(async () => secondReply.resolve({
      threadId: "thread-1", suggestions: [], actions: [], draft: null, deflected: false,
      toolsUsed: [], model: { provider: "gemini", modelId: "test" },
      messages: [
        { id: "3f1b1a2c-0000-4000-8000-000000000023", role: "user",
          content: "Pinned now", seq: 153 },
        { id: "assistant-154", role: "assistant", content: "At the bottom", seq: 154 },
      ],
    }));
    expect(scrollTop).toBe(400);
  });

  it("shows the existing honest network error when a turn fails", async () => {
    mocks.getThread.mockResolvedValue({
      thread: { id: "thread-1", title: null, kind: "chat", lastMessageAt: null },
      messages: [],
    });
    mocks.postTurn.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000010");
    const view = render(<CoachShell userId="user-1" threadId="thread-1"
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    await waitFor(() => expect(view.queryByText("Loading saved messages…")).toBeNull(), SLOW);

    sendViaDock("Hello");

    expect(await view.findByText(/No connection to Sasha/, {}, SLOW)).not.toBeNull();
  });

  it("confirms a sent message only after the server accepts it", async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    const replied = deferred<CoachTurnResponse>();
    mocks.postTurn.mockReturnValue(replied.promise);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000010");
    const states = dockStates();
    render(<CoachShell userId="user-1" threadId={null}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);

    sendViaDock("Hello");

    expect(states.seen.at(-1)?.sendFeedbackState).toBe("pending");
    expect(vibrate).not.toHaveBeenCalled();

    await act(async () => replied.resolve({
      threadId: "thread-1", suggestions: [], actions: [], draft: null, deflected: false,
      toolsUsed: [], model: { provider: "gemini", modelId: "test" },
      messages: [
        { id: "3f1b1a2c-0000-4000-8000-000000000010", role: "user", content: "Hello", seq: 1 },
        { id: "assistant-2", role: "assistant", content: "Hi", seq: 2 },
      ],
    }));

    expect(states.seen.at(-1)?.sendFeedbackState).toBe("success");
    expect(vibrate).toHaveBeenCalledTimes(1);
    states.stop();
  });

  it("keeps a failed dock send flat, silent, and explained by a toast", async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    mocks.postTurn.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000010");
    const view = render(<CoachShell userId="user-1" threadId={null}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);

    sendViaDock("Hello");

    expect(await view.findByText("Could not confirm this message was sent. No connection to Sasha.")).not.toBeNull();
    expect(view.getAllByRole("alert")).toHaveLength(1);
    expect(view.getByText(/This reply may have saved/)).not.toBeNull();
    expect(view.container.querySelector('[data-feedback-state="failed"]')).toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });
});
