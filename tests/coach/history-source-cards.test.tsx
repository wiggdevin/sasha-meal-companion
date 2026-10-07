// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import HistorySourceCards from "@/components/coach/HistorySourceCards";
import { CoachMessageExtras } from "@/components/CoachChat";

const mocks = vi.hoisted(() => ({ readHistoryEvidence: vi.fn() }));
vi.mock("@/lib/coach-client", async (original) => ({
  ...await original<typeof import("@/lib/coach-client")>(),
  readHistoryEvidence: mocks.readHistoryEvidence,
}));

afterEach(cleanup);
const source = { id: "message-1", threadId: "thread-a", seq: 3,
  createdAt: "2026-09-20T12:00:00Z", title: "Old title" };

it("shows an exact owner-checked historical passage with its source and opens that chat", async () => {
  const readEvidence = vi.fn(async () => [{ ...source, title: "Breakfast notes",
    role: "user" as const, excerpt: "I ate oats after training." }]);
  const open = vi.fn();
  render(<HistorySourceCards sources={[source]} readEvidence={readEvidence}
    onOpenConversation={open} />);
  expect(screen.getByText("Checking sources…")).toBeTruthy();
  expect(await screen.findByText(/I ate oats after training/)).toBeTruthy();
  expect(screen.getByText(/Breakfast notes/)).toBeTruthy();
  expect(screen.getByText(/Historical conversation, not your current targets/)).toBeTruthy();
  expect(readEvidence).toHaveBeenCalledWith([source]);
  fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
  expect(open).toHaveBeenCalledWith("thread-a");
});

it("does not reveal stale cached title or excerpt when the source is no longer available", async () => {
  const readEvidence = vi.fn(async () => []);
  render(<HistorySourceCards sources={[source]} readEvidence={readEvidence} />);
  await waitFor(() => expect(screen.getByText(/Source no longer available/)).toBeTruthy());
  expect(screen.queryByText("Old title")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open conversation" })).toBeNull();
});

it("renders verified citations on an assistant message with no other UI blocks", async () => {
  mocks.readHistoryEvidence.mockResolvedValue([{ ...source, title: "Breakfast notes",
    role: "user", excerpt: "I ate oats after training." }]);
  const open = vi.fn();
  render(<CoachMessageExtras
    message={{ id: "reply-1", role: "assistant", content: "You mentioned oats.", seq: 4,
      createdAt: "2026-09-20T12:01:00Z", historySources: [source] }}
    messages={[]} tz="UTC" onAttachment={vi.fn()} onSearchManually={vi.fn()}
    onBlockStatus={vi.fn()} onOpenConversation={open} />);
  expect(await screen.findByText(/I ate oats after training/)).toBeTruthy();
  expect(mocks.readHistoryEvidence).toHaveBeenCalledWith([source]);
  fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
  expect(open).toHaveBeenCalledWith("thread-a");
});
