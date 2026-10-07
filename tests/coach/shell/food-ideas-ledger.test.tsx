// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoachMessageExtras } from "@/components/CoachChat";
import CoachShell from "@/components/coach/CoachShell";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import type { CoachMessageView } from "@/lib/coach/message-view";
import type { CoachTurnResponse } from "@/lib/coach/types";
import type { FoodIdeasBlockV1 } from "@/lib/coach/ui-blocks";

const mocks = vi.hoisted(() => ({
  applyCoachAction: vi.fn(),
  undoCoachAction: vi.fn(),
  postTurn: vi.fn(),
}));

vi.mock("@/lib/coach-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach-client")>(),
  fetchOlder: vi.fn(),
  getThread: vi.fn(),
  postTurn: mocks.postTurn,
  readCache: () => ({ messages: [], actions: [] }),
  writeCache: vi.fn(),
}));

vi.mock("@/lib/coach/apply-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach/apply-client")>(),
  applyCoachAction: mocks.applyCoachAction,
  undoCoachAction: mocks.undoCoachAction,
}));

const ideas: FoodIdeasBlockV1 = { kind: "food_ideas", v: 1, id: "ideas-1", ideas: [{
  wish: "Rice bowl", slot: "meal-2", items: [{
    name: "Rice bowl", foodRefId: "11111111-1111-4111-8111-111111111111",
    catalogFoodRevisionId: 71, grams: 180,
    kcalPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3,
    macros: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 }, verdict: "allowed",
  }],
  totals: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 },
  target: { kcal: 400, protein: 30, carbs: 50, fat: 10 },
  flagged: [], fitsTarget: true,
}] };

const turn: CoachTurnResponse = {
  threadId: "4f1b1a2c-0000-4000-8000-000000000001", suggestions: [], actions: [], draft: null,
  deflected: false, toolsUsed: [], model: { provider: "gemini", modelId: "" },
  messages: [{ id: "assistant-2", role: "assistant", content: "Some ideas", seq: 2, blocks: [ideas] }],
};

function renderShell() {
  render(<CoachShell userId="user-1" threadId={null} onOpenDraft={vi.fn()} onThreadSaved={vi.fn()}
    toolbar={(controls) => <button type="button" onClick={() => controls.sendText("ideas")}>Ask</button>}
    renderExtras={(message, controls, messages, applyAction) => <CoachMessageExtras
      message={message as CoachMessageView} messages={messages as CoachMessageView[]}
      tz="America/Denver" onAttachment={controls.sendAttachment}
      onBlockStatus={controls.onBlockStatus} onSearchManually={vi.fn()}
      applyAction={applyAction} />} />);
}

beforeEach(() => { unbindAccount(); bindAccount("user-1"); mocks.postTurn.mockResolvedValue(turn); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.applyCoachAction.mockReset();
  mocks.undoCoachAction.mockReset();
  mocks.postTurn.mockReset();
});

describe("food ideas through the coach action ledger", () => {
  it("applies a double-tapped idea once and offers Undo on its action card", async () => {
    const token = { kind: "log_meal" } as never;
    mocks.applyCoachAction.mockResolvedValue({ status: "applied", token });
    mocks.undoCoachAction.mockResolvedValue(undefined);
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const logIt = await screen.findByRole("button", { name: "Log it" });
    fireEvent.click(logIt);
    fireEvent.click(logIt);

    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(mocks.applyCoachAction).toHaveBeenCalledOnce();
    const [action] = mocks.applyCoachAction.mock.calls[0];
    expect(action).toMatchObject({ kind: "log_meal", slot: "snack" });
    expect(screen.queryByRole("button", { name: "Log it" })).toBeNull();

    fireEvent.click(undo);
    await screen.findByText("Undone");
    expect(mocks.undoCoachAction).toHaveBeenCalledWith(action.actionId, token, expect.anything());
  });

  it("surfaces a failed apply on the ledger card and retries the same action", async () => {
    mocks.applyCoachAction.mockResolvedValue({ status: "failed", reason: "That meal did not save." });
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log it" }));

    expect(await screen.findByText("That meal did not save.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(mocks.applyCoachAction).toHaveBeenCalledTimes(2));
    expect(mocks.applyCoachAction.mock.calls[1][0].actionId)
      .toBe(mocks.applyCoachAction.mock.calls[0][0].actionId);
  });
});
