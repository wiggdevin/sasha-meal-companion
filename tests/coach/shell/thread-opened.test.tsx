// @vitest-environment jsdom
/**
 * CoachShell reports how a thread's opening read went (`onThreadOpened`), so the weekly review's
 * unread mark settles on the real answer (components/coach/unread-threads.ts): cleared once the
 * server says its clear held (`cleared` on the page), not cleared when the read failed or the clear
 * write did, so the mark comes back. A weekly review takes replies like any chat.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CoachShell from "@/components/coach/CoachShell";
import { CoachError } from "@/lib/coach-client";

const mocks = vi.hoisted(() => ({ getThread: vi.fn(), postTurn: vi.fn() }));
vi.mock("@/lib/coach-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach-client")>(),
  getThread: mocks.getThread,
  postTurn: mocks.postTurn,
  readCache: () => ({ messages: [], actions: [] }),
  writeCache: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const page = { thread: { id: "review-1", title: "Weekly review", kind: "weekly_review", lastMessageAt: null },
  messages: [{ id: "m-1", role: "assistant" as const, content: "Your week", seq: 1 }], cleared: true };

afterEach(() => {
  cleanup();
  mocks.getThread.mockReset();
  mocks.postTurn.mockReset();
});

describe("the opening read", () => {
  it("reports success only once the read has answered", async () => {
    const read = deferred<typeof page>();
    mocks.getThread.mockReturnValue(read.promise);
    const opened = vi.fn();
    render(<CoachShell userId="u" threadId="review-1" onThreadOpened={opened}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    expect(opened).not.toHaveBeenCalled();
    await act(async () => read.resolve(page));
    expect(opened).toHaveBeenCalledWith("review-1", true, "weekly_review");
  });

  it("reports a failed read, even after the view has gone", async () => {
    const read = deferred<typeof page>();
    mocks.getThread.mockReturnValue(read.promise);
    const opened = vi.fn();
    const view = render(<CoachShell userId="u" threadId="review-1" onThreadOpened={opened}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    view.unmount();
    await act(async () => read.reject(new CoachError(503, "timeout", "No answer.")));
    expect(opened).toHaveBeenCalledWith("review-1", false);
  });

  it("reports the thread's kind with a successful read", async () => {
    mocks.getThread.mockResolvedValue(page);
    const opened = vi.fn();
    render(<CoachShell userId="u" threadId="review-1" onThreadOpened={opened}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    expect(opened).toHaveBeenCalledWith("review-1", true, "weekly_review");
  });

  it("sends nothing until the read has said what the thread is", async () => {
    mocks.getThread.mockReturnValue(new Promise(() => {}));
    render(<CoachShell userId="u" threadId="review-1"
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit", { detail: { text: "Hi" } })));
    expect(mocks.postTurn).not.toHaveBeenCalled();
  });

  it("reports a read whose unread clear failed as not cleared, with the kind", async () => {
    mocks.getThread.mockResolvedValue({ ...page, cleared: false });
    const opened = vi.fn();
    render(<CoachShell userId="u" threadId="review-1" onThreadOpened={opened}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    expect(opened).toHaveBeenCalledWith("review-1", false, "weekly_review");
  });

  it("sends a reply in a weekly review from the dock, like any chat", async () => {
    mocks.getThread.mockResolvedValue(page);
    mocks.postTurn.mockReturnValue(new Promise(() => {}));
    render(<CoachShell userId="u" threadId="review-1"
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit", { detail: { text: "How was my week?" } })));
    await waitFor(() => expect(mocks.postTurn).toHaveBeenCalledTimes(1));
    expect(mocks.postTurn.mock.calls[0][0]).toMatchObject({ threadId: "review-1", text: "How was my week?" });
  });
});
