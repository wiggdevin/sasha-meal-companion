// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConversationPicker, { limitLine } from "@/components/coach/ConversationPicker";
import { ThreadsUnavailable, type ThreadSearchHit } from "@/lib/coach/threads-client";

afterEach(cleanup);

const NOW = new Date(2026, 9, 4, 18, 0);
const at = (days: number) => new Date(2026, 9, 4 - days, 12, 0).toISOString();
const thread = (id: string, title: string, days: number | null) =>
  ({ id, title, kind: "chat", lastMessageAt: days === null ? null : at(days) });
const THREADS = [thread("a", "Dinner ideas", 0), thread("b", "Snack swaps", 2), thread("c", "Old plan", 20),
  thread("d", "Empty", null)];

function renderPicker(overrides: Partial<Parameters<typeof ConversationPicker>[0]> = {}) {
  const props = {
    mode: "conversations" as const, threads: THREADS, currentThreadId: "a", selectedSourceId: null,
    busy: false, loading: false, error: null, onSelect: vi.fn(), onNew: vi.fn(), onClose: vi.fn(),
    onRetry: vi.fn(), onDelete: vi.fn(async () => {}), onClear: vi.fn(async () => {}),
    onRename: vi.fn(async () => {}), search: vi.fn(async (): Promise<ThreadSearchHit[]> => []),
    now: () => NOW, ...overrides,
  };
  render(<ConversationPicker {...props} />);
  return props;
}

describe("the Conversations list", () => {
  it("groups chats as Today, This week, Earlier and No messages yet, each row one line", () => {
    renderPicker();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Today", "This week", "Earlier", "No messages yet"]);
    expect(screen.getByRole("button", { name: /^Dinner ideas/ }).getAttribute("aria-current")).toBe("true");
  });

  it("opens a chat from its row", () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /^Snack swaps/ }));
    expect(props.onSelect).toHaveBeenCalledWith("b");
  });

  it("asks twice before deleting a chat for good, from the row's menu", async () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "More for Snack swaps" }));
    const actions = screen.getByRole("group", { name: "Actions for Snack swaps" });
    fireEvent.click(within(actions).getByRole("button", { name: "Delete" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(actions).getByRole("button", { name: "Delete for good" }));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith("b"));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("clears a chat's messages only after the second tap", async () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "More for Old plan" }));
    const actions = screen.getByRole("group", { name: "Actions for Old plan" });
    fireEvent.click(within(actions).getByRole("button", { name: "Clear messages" }));
    fireEvent.click(within(actions).getByRole("button", { name: "Clear for good" }));
    await waitFor(() => expect(props.onClear).toHaveBeenCalledWith("c"));
  });

  it("renames a chat in place", async () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "More for Old plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const name = screen.getByRole("textbox", { name: "Chat name" });
    fireEvent.change(name, { target: { value: "  Spring plan " } });
    fireEvent.submit(name.closest("form")!);
    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith("c", "Spring plan"));
  });

  it("says so when the server cannot manage chats yet", async () => {
    renderPicker({ onDelete: vi.fn(async () => { throw new ThreadsUnavailable(); }) });
    fireEvent.click(screen.getByRole("button", { name: "More for Snack swaps" }));
    const actions = screen.getByRole("group", { name: "Actions for Snack swaps" });
    fireEvent.click(within(actions).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(actions).getByRole("button", { name: "Delete for good" }));
    expect((await screen.findByText(/arrive with the next update/)).textContent).toContain("Deleting");
  });

  it("explains the chat limit and how to make room", () => {
    const many = Array.from({ length: 8 }, (_, index) => thread(String(index), `Chat ${index}`, index));
    renderPicker({ threads: many, currentThreadId: "0" });
    const button = screen.getByRole("button", { name: "New chat · make room first" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByText(/Delete one to start a new chat/)).toBeTruthy();
  });

  it("at the limit, New chat says why, focuses the list and shows what to delete instead of starting one", () => {
    const many = Array.from({ length: 8 }, (_, index) => thread(String(index), `Chat ${index}`, index));
    const props = renderPicker({ threads: many, currentThreadId: "0" });
    fireEvent.click(screen.getByRole("button", { name: "New chat · make room first" }));
    expect(props.onNew).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Saved conversations" }));
    expect(screen.getByText("Delete a chat to make room").closest("[role=status]")).toBeTruthy();
  });

  it("counts how many chats must go when an older account holds more than the limit", () => {
    expect(limitLine(15, 8)).toBe("You can keep 8 chats and have 15. Delete 8 to start a new chat: swipe each left, or use its … menu.");
    expect(limitLine(8, 8)).toMatch(/^You can keep 8 chats\. Delete one/);
  });
});

describe("searching chats", () => {
  it("filters titles at once and asks the server from three characters, showing the matching line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const search = vi.fn(async (): Promise<ThreadSearchHit[]> => [
      { threadId: "c", title: "Old plan", matches: [{ messageId: "m1", snippet: "…salmon and rice…", at: at(20) }] },
    ]);
    renderPicker({ search });
    const field = screen.getByRole("searchbox", { name: "Search chats" });

    fireEvent.change(field, { target: { value: "sn" } });
    expect(screen.getByRole("button", { name: /^Snack swaps/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Dinner ideas/ })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(search).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "salmon" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(search).toHaveBeenCalledWith("salmon", expect.any(AbortSignal));
    const row = await screen.findByRole("button", { name: /^Old plan/ });
    expect(row.textContent).toContain("salmon and rice");
    expect(row.querySelector("mark")?.textContent).toBe("salmon");
    vi.useRealTimers();
  });

  it("keeps searching titles when message search is not there yet", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPicker({ search: vi.fn(async () => { throw new ThreadsUnavailable(); }) });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), { target: { value: "dinner" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByText(/Searching inside messages arrives with the next update/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Dinner ideas/ })).toBeTruthy();
    vi.useRealTimers();
  });
});
