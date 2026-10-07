// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import BarcodeDraftEditor from "@/components/coach/editors/BarcodeDraftEditor";
import CaptureDraftEditor from "@/components/coach/editors/CaptureDraftEditor";
import { barcodeResponse, captureProposal } from "@/tests/coach/editors/fixtures";

const noop = () => {};

afterEach(cleanup);

function expectMinimumTapTarget(button: HTMLElement): void {
  const style = getComputedStyle(button);
  expect(Number.parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
  expect(Number.parseFloat(style.minWidth)).toBeGreaterThanOrEqual(44);
}

describe("draft editor fields", () => {
  it("keeps every barcode confirmation field, the no ingredient list warning included, in the"
    + " extracted editor", () => {
    const markup = renderToStaticMarkup(
      <BarcodeDraftEditor
        draft={{ response: barcodeResponse, slot: "meal-2" }}
        onCommit={noop}
        onSearchManually={noop}
        onDismiss={noop}
        onFavorite={noop}
      />,
    );

    expect(markup).toMatchSnapshot();
    for (const label of [
      "No ingredient list — check the pack", "Favourite this food", "Portion", "6 crackers",
      "How many", "30 g", "Slot", "Meal 2", "Ingredients", "Rice, sea salt", "Log it",
      "Search manually", "Dismiss",
    ]) expect(markup).toContain(label);
  });

  it("keeps every capture confirmation field, the try another match row included, in the"
    + " extracted editor", () => {
    const markup = renderToStaticMarkup(
      <CaptureDraftEditor
        draft={{
          proposal: captureProposal,
          slot: "meal-1",
          portions: { 1: [{ id: 7, description: "one palm", gramWeight: 100, isDefault: true }] },
        }}
        onCommit={noop}
        onSearchManually={noop}
        onDismiss={noop}
        onRerunAsLabel={noop}
      />,
    );

    expect(markup).toMatchSnapshot();
    for (const label of [
      "Check the amount.", "Roast chicken", "Best guess. Check it.", "Not checked",
      "Grams", "120 g", "Portion", "one palm", "Try another match", "Chicken breast", "Remove",
      "Slot", "Meal 1", "Log it", "Search manually", "This was a nutrition label", "Dismiss",
    ]) expect(markup).toContain(label);
  });

  it("keeps barcode slot pills and portion pills at least 44 by 44 pixels", () => {
    render(<BarcodeDraftEditor draft={{ response: barcodeResponse, slot: "meal-2" }}
      onCommit={noop} onSearchManually={noop} onDismiss={noop} />);

    expectMinimumTapTarget(screen.getByRole("button", { name: "Meal 2" }));
    expectMinimumTapTarget(screen.getByRole("button", { name: "30 g · 6 crackers" }));
    expectMinimumTapTarget(screen.getByRole("button", { name: "100 g" }));
  });

  it("keeps capture slot pills, portion pills and alternative pills at least 44 by 44 pixels", () => {
    render(<CaptureDraftEditor draft={{ proposal: captureProposal, slot: "meal-1",
      portions: { 1: [{ id: 7, description: "one palm", gramWeight: 100, isDefault: true }] } }}
      onCommit={noop} onSearchManually={noop} onDismiss={noop} />);

    expectMinimumTapTarget(screen.getByRole("button", { name: "Meal 1" }));
    expectMinimumTapTarget(screen.getByRole("button", { name: "one palm · 100 g" }));
    expectMinimumTapTarget(screen.getByRole("button", { name: "Chicken breast" }));
  });

  it("finding #11: a matched photo/voice/label item shows each allergen finding's own text, not " +
    "just the verdict pill's colour — the pregnancy/tuna finding included", () => {
    const proposal = { ...captureProposal, items: [{
      ...captureProposal.items[0],
      policy: {
        verdict: "unverified" as const,
        allergens: [
          { allergen: "dairy", outcome: "absent" as const, text: "No dairy listed on the label",
            checkable: false },
          { allergen: "tuna_mercury", outcome: "unknown" as const, checkable: false,
            text: "Unspecified tuna — mercury varies by species. Check the label for the kind, or "
              + "ask your clinician about mercury limits during pregnancy." },
        ],
      },
    }] };
    render(<CaptureDraftEditor draft={{ proposal, slot: "meal-1", portions: {} }}
      onCommit={noop} onSearchManually={noop} onDismiss={noop} />);

    expect(screen.getByText("No dairy listed on the label")).toBeTruthy();
    expect(screen.getByText(/Unspecified tuna/)).toBeTruthy();
  });

  it("shows nothing extra for an item with no allergen findings (unchanged markup)", () => {
    const markup = renderToStaticMarkup(
      <CaptureDraftEditor draft={{ proposal: captureProposal, slot: "meal-1", portions: {} }}
        onCommit={noop} onSearchManually={noop} onDismiss={noop} />,
    );
    expect(markup).not.toContain("aria-label=\"Allergens\"");
  });
});
