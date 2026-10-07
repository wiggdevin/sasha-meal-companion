// @vitest-environment jsdom
/**
 * `ApplyResult.notices` (lib/coach/apply-entries.ts: a recipe's refused ingredients) used to stop at
 * CoachShell. The shell now carries them through `action_applied` to the action card.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CoachShell from "@/components/coach/CoachShell";
import type { CoachAction } from "@/lib/coach/actions";
import type { ChatMessage } from "@/lib/coach/chat-state";

const THREAD = "3f1b1a2c-0000-4000-8000-000000000001";
const MESSAGE = "3f1b1a2c-0000-4000-8000-0000000000aa";
const recipe = { kind: "save_recipe", actionId: "act-1", flagged: [], name: "Eggs on toast", items: [] } as unknown as CoachAction;
const saved = { id: MESSAGE, role: "assistant", content: "Saved your recipe.", seq: 2 } as ChatMessage;

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(), applyCoachAction: vi.fn(),
  cache: { messages: [] as unknown[], actions: [] as unknown[] },
}));
vi.mock("@/lib/device/account", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/device/account")>(),
  currentAccountOrNull: () => ({ userId: "user-1", epoch: 1 }), isCurrent: () => true,
}));
vi.mock("@/lib/coach-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach-client")>(),
  getThread: mocks.getThread, readCache: () => mocks.cache, writeCache: vi.fn(),
}));
vi.mock("@/lib/coach/undo-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach/undo-client")>(),
  listCoachUndos: vi.fn(async () => []),
}));
vi.mock("@/lib/coach/apply-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach/apply-client")>(),
  applyCoachAction: mocks.applyCoachAction,
}));

afterEach(() => { cleanup(); mocks.getThread.mockReset(); mocks.applyCoachAction.mockReset(); });

it("shows a save's notices on its action card once it applies", async () => {
  const notices = ["Left out Brie: not verified."];
  mocks.applyCoachAction.mockResolvedValue({ status: "applied", token: { kind: "save_recipe", recipeId: "r1", rev: 1 },
    notices });
  // A restored pending entry turns failed; Retry applies it again, and this time it lands.
  mocks.cache = { messages: [saved], actions: [{ action: recipe, status: "pending", messageId: MESSAGE }] };
  mocks.getThread.mockResolvedValue({ thread: { id: THREAD, title: null, kind: "chat", lastMessageAt: null },
    messages: [saved], cleared: true });
  render(<CoachShell userId="user-1" threadId={THREAD} onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

  expect(await screen.findByText(notices[0])).toBeTruthy();
  expect(screen.getByText("Done")).toBeTruthy();
});
