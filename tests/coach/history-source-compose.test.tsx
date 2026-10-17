// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CoachShell from "@/components/coach/CoachShell";
import { asksAboutAnotherConversation } from "@/lib/coach/chat-state";
import { CoachError } from "@/lib/coach-client";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coach-client", async (original) => ({
  ...await original<typeof import("@/lib/coach-client")>(),
  postTurn: post,
}));
afterEach(() => { cleanup(); post.mockReset(); });

/** The dock is the one way into a turn now (CoachShell owns no composer of its own); `send()`
 *  itself — not a composer-level wrapper — is what intercepts an another-chat question, so this
 *  is the same interception whichever trigger reaches it. */
function sendViaDock(text: string): void {
  act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit", { detail: { text } })));
}

it("opens explicit source choice for another-chat questions instead of posting it", () => {
  const openSource = vi.fn();
  render(<CoachShell userId="u" threadId={null} onOpenDraft={vi.fn()}
    onThreadSaved={vi.fn()} onOpenHistorySource={openSource} />);
  sendViaDock("What did I say in another conversation?");
  expect(openSource).toHaveBeenCalledOnce();
  expect(post).not.toHaveBeenCalled();
  expect(asksAboutAnotherConversation("What about this conversation?")).toBe(false);
});

it("sends the selected source with a text turn and blocks changing it while busy", async () => {
  post.mockReturnValue(new Promise(() => {}));
  const clear = vi.fn();
  render(<CoachShell userId="u" threadId={null} onOpenDraft={vi.fn()}
    onThreadSaved={vi.fn()} historySourceThreadId="source-thread"
    historySourceTitle="Breakfast notes" onOpenHistorySource={vi.fn()}
    onClearHistorySource={clear} />);
  expect(screen.getByText(/Using Breakfast notes/)).toBeTruthy();
  sendViaDock("What did I say about breakfast?");
  await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({
    text: "What did I say about breakfast?", historySourceThreadId: "source-thread",
  }), expect.anything()));
  expect(screen.getByRole("button", { name: "Ask from history" }).hasAttribute("disabled")).toBe(true);
});

it("keeps a failed first history turn for same-ID retry, then clears its source on success", async () => {
  post.mockRejectedValueOnce(new Error("network lost"));
  post.mockResolvedValueOnce({ threadId: "saved-thread", suggestions: [], actions: [], draft: null,
    deflected: false, toolsUsed: [], model: { provider: "gemini", modelId: "" },
    messages: [
      { id: "saved-user", role: "user", content: "What did I pack?", seq: 1 },
      { id: "saved-reply", role: "assistant", content: "You packed mango.", seq: 2 },
    ] });
  const clear = vi.fn();
  render(<CoachShell userId="u" threadId={null} onOpenDraft={vi.fn()}
    onThreadSaved={vi.fn()} historySourceThreadId="source-thread"
    onOpenHistorySource={vi.fn()} onClearHistorySource={clear} />);
  sendViaDock("What did I pack?");
  await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
  expect(clear).not.toHaveBeenCalled();
  expect(screen.getByText(/This reply may have saved/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[1][0].messageId).toBe(post.mock.calls[0][0].messageId);
  expect(post.mock.calls[1][0].historySourceThreadId).toBe("source-thread");
  await waitFor(() => expect(clear).toHaveBeenCalledOnce());
});

it("blocks a new first-turn send after 503 while keeping the original retry ID", async () => {
  post.mockRejectedValueOnce(new CoachError(503, "timeout", "Reply still settling."));
  post.mockReturnValueOnce(new Promise(() => {}));
  render(<CoachShell userId="u" threadId={null} onOpenDraft={vi.fn()}
    onThreadSaved={vi.fn()} />);
  sendViaDock("Help me plan breakfast");
  await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
  sendViaDock("A different first turn");
  expect(post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[1][0].messageId).toBe(post.mock.calls[0][0].messageId);
  expect(post.mock.calls[1][0].threadId).toBeNull();
  expect(post.mock.calls[1][0].text).toBe("Help me plan breakfast");
});
