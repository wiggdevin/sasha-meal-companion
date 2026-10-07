// @vitest-environment jsdom
/**
 * Option A follow-ups on the capture review: one or two "How much of the … did you have?" questions with the
 * matched food's portions as tap answers. Skippable; the grams stepper still edits the same item.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CaptureDraftEditor from "@/components/coach/editors/CaptureDraftEditor";
import type { DraftItem, ProposeResponse } from "@/lib/capture/types";
import { captureProposal } from "@/tests/coach/editors/fixtures";

afterEach(() => cleanup());
const noop = () => {};

function item(seq: number, label: string, confidence: number, patch: Partial<DraftItem> = {}): DraftItem {
  return { ...captureProposal.items[0], seq, label, confidence, foodRefId: `3333333${seq}-3333-4333-8333-333333333333`,
    catalogFoodRevisionId: 20 + seq, grams: 150, qty: 1, unit: "whole", portionId: null,
    alternatives: [], ...patch };
}
const PORTIONS = [
  { id: 71, description: "1 small sandwich", gramWeight: 120, isDefault: false },
  { id: 72, description: "1 sandwich", gramWeight: 180, isDefault: true },
];

function renderEditor(items: DraftItem[], onCommit = vi.fn()) {
  const proposal: ProposeResponse = { ...captureProposal, method: "text", items, notes: [] };
  const portions = Object.fromEntries(items.map((row) => [row.seq, PORTIONS]));
  render(<CaptureDraftEditor draft={{ proposal, portions }} onCommit={onCommit}
    onSearchManually={noop} onDismiss={noop} />);
  return onCommit;
}

describe("portion follow-ups on the capture review", () => {
  it("asks how big, and a tap sets that item's portion and grams", () => {
    const onCommit = renderEditor([item(0, "turkey sandwich with cheese", 0.4)]);
    const group = screen.getByRole("group", { name: "How much of the turkey sandwich with cheese did you have?" });
    const answers = within(group).getAllByRole("button");
    expect(answers.map((b) => b.textContent)).toEqual(["1 sandwich · 180 g", "1 small sandwich · 120 g"]);
    for (const answer of answers) expect(answer.style.minHeight).toBe("44px");

    fireEvent.click(answers[1]);
    expect(within(group).getByRole("button", { name: "1 small sandwich · 120 g" })
      .getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    expect(onCommit.mock.calls[0][0].items[0]).toMatchObject(
      { grams: 120, qty: 1, unit: "portion", portionId: 71 });
  });

  it("asks at most two questions, least confident first", () => {
    renderEditor([item(0, "toast", 0.5), item(1, "soup", 0.2), item(2, "salad", 0.3)]);
    expect(screen.getAllByRole("group").map((g) => g.textContent?.split("?")[0]))
      .toEqual(["How much of the soup did you have", "How much of the salad did you have"]);
  });

  it("can be skipped: saving without an answer keeps the proposal as it was", () => {
    const onCommit = renderEditor([item(0, "bagel", 0.4)]);
    expect(screen.getByRole("group", { name: "How much of the bagel did you have?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    expect(onCommit.mock.calls[0][0].items).toEqual({});
  });

  it("asks nothing when the amount was given or the model was sure", () => {
    renderEditor([item(0, "rice", 0.9), item(1, "chicken", 0.3, { qty: 150, unit: "g" })]);
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByText(/How much of the/)).toBeNull();
  });

  it("drops the question when its item is removed", () => {
    renderEditor([item(0, "bagel", 0.4)]);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("How much of the bagel did you have?")).toBeNull();
  });
});
