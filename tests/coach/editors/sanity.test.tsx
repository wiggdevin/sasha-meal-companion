// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CoachActionCard from "@/components/CoachActionCard";
import BarcodeDraftEditor from "@/components/coach/editors/BarcodeDraftEditor";
import CaptureDraftEditor from "@/components/coach/editors/CaptureDraftEditor";
import LogDraftBlock from "@/components/coach/blocks/log_draft";
import type { BarcodeResponse } from "@/lib/barcode/client";
import type { CoachAction } from "@/lib/coach/actions";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";
import { barcodeResponse, captureProposal } from "@/tests/coach/editors/fixtures";

const noop = () => {};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function warnedProposal() {
  return {
    ...captureProposal,
    items: [{
      ...captureProposal.items[0], grams: 1, qty: 1,
      sanity: {
        status: "warn" as const,
        warnings: [{ itemId: "1", kind: "portion" as const, level: "tiny" as const,
          message: "This serving is under 2 g." }],
      },
      typicalServing: { grams: 100, label: "one palm" },
    }],
  };
}

describe("sanity in draft editors and cards", () => {
  it("shows a plain warning and uses the typical grams through the existing log_draft edit path", async () => {
    const commitCapture = vi.fn().mockResolvedValue({
      entryIds: ["entry-1"], summary: "Roast chicken",
    });
    const block = {
      kind: "log_draft", v: 1, id: "block-1", source: "capture", method: "photo",
      localDate: "2026-09-20", slot: "meal-1", draft: warnedProposal(),
      policy: { blocked: false }, status: "pending",
    } satisfies LogDraftBlockV1;
    render(<LogDraftBlock block={block} ctx={{
      tz: "America/Denver", onBlockStatus: vi.fn(), onSearchManually: noop,
      rerunAsLabel: noop, commitCapture,
    }} />);

    expect(screen.getByText("Looks like a small portion for one serving.")).toBeTruthy();
    const typical = screen.getByRole("button", { name: "Use typical serving" });
    expect(Number.parseFloat(getComputedStyle(typical).minHeight)).toBeGreaterThanOrEqual(44);
    expect((screen.getByRole("button", { name: "Log it" }) as HTMLButtonElement).disabled)
      .toBe(false);

    fireEvent.click(typical);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    await waitFor(() => expect(commitCapture).toHaveBeenCalledOnce());
    expect(commitCapture.mock.calls[0][1].items).toMatchObject({
      1: { grams: 100, qty: 100, unit: "g", portionId: null },
    });
  });

  it("marks unknown sanity only when an active preference needs evidence", () => {
    const proposal = {
      ...captureProposal,
      items: [{
        ...captureProposal.items[0],
        policy: { verdict: "unverified" as const, marks: [{
          facet: "contains_soy", source: "jev" as const, outcome: "unknown" as const,
        }] },
        sanity: { status: "unknown" as const, warnings: [] },
      }],
    };
    render(<CaptureDraftEditor draft={{ proposal, portions: {}, slot: "meal-1" }}
      onCommit={noop} onSearchManually={noop} onDismiss={noop} />);

    expect(screen.getByText("We could not verify this food for your preferences.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Log it" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("does not mark a generically ungroundable item as preference-unverified", () => {
    const proposal = {
      ...captureProposal,
      items: [{
        ...captureProposal.items[0], policy: { verdict: "unverified" as const },
        sanity: { status: "unknown" as const, warnings: [] },
      }],
    };
    render(<CaptureDraftEditor draft={{ proposal, portions: {}, slot: "meal-1" }}
      onCommit={noop} onSearchManually={noop} onDismiss={noop} />);

    expect(screen.queryByText("We could not verify this food for your preferences.")).toBeNull();
  });

  it("commits explicit typical grams when no catalog portion matches", () => {
    const onCommit = vi.fn();
    const response = {
      status: "resolved", gtin14: "00012345678905", cached: false,
      match: {
        ...barcodeResponse.match,
        portions: [{ id: 12, description: "6 crackers", gramWeight: 30, isDefault: false }],
        sanity: { status: "warn", warnings: [{
          itemId: barcodeResponse.match.foodRefId, kind: "portion", level: "small",
          message: "Small serving.",
        }] },
        typicalServing: { grams: 37.4, label: "one packet" },
      },
    } as BarcodeResponse;
    render(<BarcodeDraftEditor draft={{
      response,
      slot: "meal-1",
    }} onCommit={onCommit} onSearchManually={noop} onDismiss={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "Use typical serving" }));
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
      portionId: null, qty: 1, grams: 37.4,
    }));
  });

  it("shows and commits the 100 g choice when a barcode has no portions", () => {
    const onCommit = vi.fn();
    const response = {
      ...barcodeResponse,
      match: { ...barcodeResponse.match, portions: [] },
    } as BarcodeResponse;
    render(<BarcodeDraftEditor draft={{ response, slot: "meal-1" }} onCommit={onCommit}
      onSearchManually={noop} onDismiss={noop} />);

    expect(screen.getByRole("button", { name: "100 g" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
      portionId: null, qty: 1, grams: 100,
    }));
  });

  it("shows preference verification only for grounded log-meal marks", () => {
    const baseItem = {
      name: "rice", grams: 100, foodRefId: "33333333-3333-4333-8333-333333333333",
      catalogFoodRevisionId: 77, kcalPer100g: 130, proteinPer100g: 2.7,
      carbsPer100g: 28, fatPer100g: 0.3, verdict: "unverified" as const,
      sanity: { status: "unknown" as const, warnings: [] },
    };
    const marked: CoachAction = {
      actionId: "marked", kind: "log_meal", date: "2026-09-20", slot: "meal-1",
      items: [{ ...baseItem, marks: [{
        facet: "contains_soy", source: "jev", outcome: "unknown",
      }] }], flagged: [],
    };
    const first = render(<CoachActionCard action={marked} status="pending" canUndo={false}
      onRetry={noop} onUndo={noop} />);
    expect(screen.getByText("We could not verify this food for your preferences.")).toBeTruthy();

    first.unmount();
    render(<CoachActionCard action={{ ...marked, actionId: "ungrounded", items: [baseItem] }}
      status="pending" canUndo={false} onRetry={noop} onUndo={noop} />);
    expect(screen.queryByText("We could not verify this food for your preferences.")).toBeNull();
  });

  it("shows sanity on log_meal cards only", () => {
    const item = {
      name: "rice", grams: 1, foodRefId: "33333333-3333-4333-8333-333333333333",
      catalogFoodRevisionId: 77, kcalPer100g: 130, proteinPer100g: 2.7,
      carbsPer100g: 28, fatPer100g: 0.3, verdict: "allowed" as const,
      sanity: { status: "warn" as const, warnings: [{ itemId: "a:0", kind: "portion" as const,
        level: "tiny" as const, message: "This serving is under 2 g." }] },
    };
    const action: CoachAction = {
      actionId: "a", kind: "log_meal", date: "2026-09-20", slot: "meal-1",
      items: [item], flagged: [],
    };
    const first = render(<CoachActionCard action={action} status="pending" canUndo={false}
      onRetry={noop} onUndo={noop} />);
    expect(screen.getByText("Looks like a small portion for one serving.")).toBeTruthy();

    first.unmount();
    render(<CoachActionCard action={{ actionId: "b", kind: "add_slot_item",
      date: "2026-09-20", slot: "meal-1", item, flagged: [] }} status="pending"
      canUndo={false} onRetry={noop} onUndo={noop} />);
    expect(screen.queryByText("Looks like a small portion for one serving.")).toBeNull();
  });
});
