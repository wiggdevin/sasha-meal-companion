// @vitest-environment jsdom
/**
 * UI audit 2026-10-18 §6: a capture that found nothing tells the user to search, so the sheet
 * offers that search; a draft whose every item matched keeps its footer as it was.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CaptureConfirm from "@/components/CaptureConfirm";
import type { ProposeResponse } from "@/lib/capture/types";

const EMPTY: ProposeResponse = {
  draftId: "3b1f0c62-3d2c-4a52-9a1e-0c2f5d8a7b11", method: "photo", notes: [],
  spend: { usedToday: 1, softCap: 20 }, items: [],
};
const MATCHED: ProposeResponse = {
  ...EMPTY,
  items: [{
    seq: 1, label: "Banana, raw", foodRefId: "11111111-1111-4111-8111-111111111111",
    catalogFoodRevisionId: 910, grams: 120, qty: 1, unit: "each", portionId: null,
    confidence: 0.9, policy: { verdict: "allowed" }, alternatives: [], autoResolved: true,
  }],
};

afterEach(cleanup);

describe("CaptureConfirm search way out", () => {
  it("offers Search manually when nothing came back", () => {
    const onSearchManually = vi.fn();
    render(<CaptureConfirm draft={EMPTY} saving={false} onSave={vi.fn()} onDismiss={vi.fn()}
      onSearchManually={onSearchManually} />);
    expect(screen.getByText(/Nothing came back to check/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search manually" }));
    expect(onSearchManually).toHaveBeenCalledOnce();
  });

  it("offers it once every item is removed", () => {
    render(<CaptureConfirm draft={MATCHED} saving={false} onSave={vi.fn()} onDismiss={vi.fn()}
      onSearchManually={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Search manually" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("button", { name: "Search manually" })).toBeTruthy();
  });

  it("offers nothing without a search to open", () => {
    render(<CaptureConfirm draft={EMPTY} saving={false} onSave={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Search manually" })).toBeNull();
  });
});
