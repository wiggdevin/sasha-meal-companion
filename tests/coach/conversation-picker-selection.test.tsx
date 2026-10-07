// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ConversationPicker from "@/components/coach/ConversationPicker";

afterEach(cleanup);

const thread = (id: string) => ({
  id,
  kind: "chat" as const,
  title: `Chat ${id}`,
  lastMessageAt: "2026-09-27T12:00:00Z",
});

function renderPicker(selectedSourceId: string) {
  render(<ConversationPicker mode="source" threads={[thread("current"), thread("other")]}
    currentThreadId="current" selectedSourceId={selectedSourceId}
    busy={false} loading={false} error={null}
    onSelect={vi.fn()} onNew={vi.fn()} onClose={vi.fn()} onRetry={vi.fn()} />);
}

it("visibly highlights only the selected source conversation", () => {
  renderPicker("other");

  const current = screen.getByRole("button", { name: "This conversation" });
  const selected = screen.getByRole("button", { name: /^Chat other/ });

  expect(current.getAttribute("aria-pressed")).toBe("false");
  expect(current.classList.contains("btn-primary")).toBe(false);
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  expect(selected.getAttribute("data-selected")).toBe("true");
});

it("closes from its top X and on Escape", () => {
  const onClose = vi.fn();
  render(<ConversationPicker mode="conversations" threads={[thread("current")]}
    currentThreadId="current" selectedSourceId={null}
    busy loading={false} error={null}
    onSelect={vi.fn()} onNew={vi.fn()} onClose={onClose} onRetry={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Conversations" });
  const closes = screen.getAllByRole("button", { name: "Close" });
  fireEvent.click(closes[closes.length - 1]);
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);
});
