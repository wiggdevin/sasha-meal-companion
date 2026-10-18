// @vitest-environment jsdom
import "fake-indexeddb/auto";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import CaptureConfirm from "@/components/CaptureConfirm";
import CaptureDraftEditor from "@/components/coach/editors/CaptureDraftEditor";
import ScanConfirmSheet from "@/components/ScanConfirmSheet";
import type { BarcodeResponse } from "@/lib/barcode/client";
import { commitLogEntry } from "@/lib/log-commit-client";
import { barcodeResponse, captureProposal } from "@/tests/coach/editors/fixtures";
import { resetTestAccount } from "@/tests/helpers/account";
import { putRevision } from "@/lib/db/catalog-cache";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";

const noop = () => {};
const projection = {
  consumed: { kcal: 1200, protein: 80, carbs: 130, fat: 69 },
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
};

vi.mock("@/lib/log-commit-client", () => ({ commitLogEntry: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("legacy confirmation sheets", () => {
  it("updates the scan projection as the serving quantity changes", () => {
    render(<ScanConfirmSheet response={barcodeResponse} slot="meal-2"
      projection={projection} onLogged={noop} onClose={noop} />);
    expect(screen.getByText("Fat 69 → 70 / 70 g")).toBeTruthy();
    for (let tap = 0; tap < 4; tap += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Increase How many" }));
    }
    expect(screen.getByText("Fat 69 → 71 / 70 g")).toBeTruthy();
    expect(screen.getByLabelText("Fat 69 to 71 of 70 g, 1 g over")
      .getAttribute("data-over-goal")).toBe("fat");
  });

  it("updates the capture projection when the proposed grams are edited", () => {
    const item = captureProposal.items[0];
    render(<CaptureDraftEditor draft={{ proposal: captureProposal, portions: {},
      revisions: { [item.seq]: {
        revision_id: item.catalogFoodRevisionId!, catalog_food_id: 8,
        description: item.label, brand: null, source: "fdc_sr_legacy", version_label: "test",
        per_100g: { energy_kcal: 200, protein: 25, carbohydrate: 0, fat_total: 10 },
        portions: [], cached_at: "2026-09-26T00:00:00.000Z",
      } } }} projection={projection} onCommit={noop} onSearchManually={noop} onDismiss={noop} />);
    expect(screen.getByText("Fat 69 → 81 / 70 g")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Increase Grams" }));
    expect(screen.getByText("Fat 69 → 82 / 70 g")).toBeTruthy();
    expect(screen.getByLabelText("Fat 69 to 82 of 70 g, 12 g over")
      .getAttribute("data-over-goal")).toBe("fat");
  });
  it("explains why a mixed capture cannot show a complete projection", () => {
    render(<CaptureDraftEditor draft={{ proposal: captureProposal, portions: {} }}
      projection={projection} onCommit={noop} onSearchManually={noop} onDismiss={noop} />);
    expect(screen.getByRole("status").textContent).toContain(
      "Resolve each food and portion to preview day totals.");
    expect(screen.queryByLabelText("Projected day totals")).toBeNull();
  });
  it("previews the chosen Banana revision after resolving a typed 100 g meal", async () => {
    await resetTestAccount();
    const bananaRef = "77777777-7777-4777-8777-777777777777";
    const banana = { revision_id: 70, catalog_food_id: 8,
      description: "Banana, raw", brand: null, source: "fdc_branded", version_label: "test-1",
      per_100g: { energy_kcal: 89, protein: 1.1, carbohydrate: 22.8, fat_total: 0.3 },
      portions: [], cached_at: "2026-09-26T00:00:00.000Z" };
    const proposal = { ...captureProposal, method: "text" as const, items: [{
      ...captureProposal.items[0], label: "banana", foodRefId: null,
      catalogFoodRevisionId: null, grams: 100, qty: 100, unit: "g", portionId: null,
      alternatives: [{ foodRefId: bananaRef, catalogFoodRevisionId: 70,
        label: "Banana, raw", score: 0.8 }],
    }] };
    await putRevision(banana);
    render(<CaptureConfirm draft={proposal} projection={projection} saving={false}
      onSave={noop} onDismiss={noop} />);
    expect(screen.getByText("Resolve each food and portion to preview day totals.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Banana, raw" }));
    // The calorie figures sit in calorie-coloured spans (DESIGN.md §Colors, 2026-10-03).
    await screen.findByText((_, node) => node?.tagName === "P"
      && node.textContent === "Calories 1,200 → 1,289 / 2,000 kcal");
    expect(screen.getByRole("button", { name: "Save 1 item" })).not.toHaveProperty("disabled", true);
  });
  it("clears a mounted capture preview when its account leaves", async () => {
    await resetTestAccount();
    const item = captureProposal.items[0];
    await putRevision({ revision_id: item.catalogFoodRevisionId!, catalog_food_id: 8,
      description: item.label, brand: null, source: "fdc_sr_legacy", version_label: "test",
      per_100g: { energy_kcal: 200, protein: 25, carbohydrate: 0, fat_total: 10 },
      portions: [], cached_at: "2026-09-26T00:00:00.000Z" });
    render(<CaptureConfirm draft={captureProposal} projection={projection} saving={false}
      onSave={noop} onDismiss={noop} />);
    await screen.findByText("Fat 69 → 81 / 70 g");
    act(() => { unbindAccount(); });
    expect(screen.queryByLabelText("Projected day totals")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Resolve each food and portion");
    act(() => { const account = bindAccount("22222222-2222-4222-8222-222222222222");
      markAccountReady(account); });
    expect(screen.queryByLabelText("Projected day totals")).toBeNull();
  });
  it("does not project an alternative whose loaded revision differs from its selected pin", () => {
    const original = captureProposal.items[0];
    const ref = "77777777-7777-4777-8777-777777777777";
    const proposal = { ...captureProposal, items: [{ ...original, foodRefId: null,
      catalogFoodRevisionId: null, alternatives: [{ foodRefId: ref,
        catalogFoodRevisionId: 70, label: "Banana, raw", score: 0.8 }] }] };
    render(<CaptureDraftEditor draft={{ proposal, portions: {}, alternativeRevisions: {
      [ref]: { revision_id: 71, catalog_food_id: 8, description: "Wrong revision",
        brand: null, source: "fdc_branded", version_label: "test",
        per_100g: { energy_kcal: 890, protein: 1, carbohydrate: 0, fat_total: 0 },
        portions: [], cached_at: "2026-09-26T00:00:00.000Z" },
    } }} projection={projection} onCommit={noop} onSearchManually={noop} onDismiss={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Banana, raw" }));
    expect(screen.queryByLabelText("Projected day totals")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Resolve each food and portion");
  });
  it("keeps the scan sheet chrome around the extracted barcode editor", () => {
    const markup = renderToStaticMarkup(
      <ScanConfirmSheet response={barcodeResponse} slot="meal-2"
        onLogged={noop} onClose={noop} onSearch={noop} />,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Plain rice crackers");
    expect(markup).toContain("Log it");
    expect(markup).not.toContain(">Slot<");
    expect(markup).not.toContain("Search manually");
    expect(markup).not.toContain(">Dismiss<");
  });

  it("keeps Search as the only scan action for an unknown barcode", () => {
    const response: BarcodeResponse = {
      status: "not_found", gtin14: "00012345678905", searchHint: { name: "Rice crackers" },
    };
    const markup = renderToStaticMarkup(
      <ScanConfirmSheet response={response} slot="meal-2"
        onLogged={noop} onClose={noop} onSearch={noop} />,
    );

    expect(markup).toContain("Search for it instead");
    expect(markup).not.toContain(">Slot<");
    expect(markup).not.toContain(">Dismiss<");
  });

  it("keeps the capture sheet chrome around the extracted capture editor", () => {
    const markup = renderToStaticMarkup(
      <CaptureConfirm draft={captureProposal} saving={false}
        onSave={noop} onDismiss={noop} onSearchManually={noop} />,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Check this");
    expect(markup).toContain("Roast chicken");
    expect(markup).toContain("Save 1 item");
    expect(markup).not.toContain("Search manually");
    expect(markup).not.toContain(">Dismiss<");
    expect(markup).toContain('class="min-w-0 shrink-0"><div class="flex flex-col gap-2 pt-1"><button');
  });

  it("logs the scan through the existing commit path with the sheet slot", async () => {
    vi.mocked(commitLogEntry).mockResolvedValue({ status: "queued" });
    const onLogged = vi.fn();
    render(<ScanConfirmSheet response={barcodeResponse} slot="meal-2"
      onLogged={onLogged} onClose={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    await waitFor(() => expect(commitLogEntry).toHaveBeenCalledOnce());
    expect(vi.mocked(commitLogEntry).mock.calls[0][0]).toMatchObject({ slot: "meal-2" });
    await waitFor(() => expect(onLogged).toHaveBeenCalledOnce());
  });

  it("keeps scan search separate from dismiss", () => {
    const onSearch = vi.fn();
    const onClose = vi.fn();
    const response: BarcodeResponse = {
      status: "not_found", gtin14: "00012345678905", searchHint: { name: "Rice crackers" },
    };
    render(<ScanConfirmSheet response={response} slot="meal-2"
      onLogged={noop} onClose={onClose} onSearch={onSearch} />);

    fireEvent.click(screen.getByRole("button", { name: "Search for it instead" }));
    expect(onSearch).toHaveBeenCalledWith("Rice crackers");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves capture edits without inventing a slot and keeps close separate from search", () => {
    const onSave = vi.fn();
    const onDismiss = vi.fn();
    const onSearchManually = vi.fn();
    render(<CaptureConfirm draft={captureProposal} saving={false} onSave={onSave}
      onDismiss={onDismiss} onSearchManually={onSearchManually} />);

    expect(screen.queryByRole("button", { name: "Search manually" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save 1 item" }));
    expect(onSave).toHaveBeenCalledWith({}, false);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onSearchManually).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onSearchManually).not.toHaveBeenCalled();
  });

  it("passes the capture sheet slot only when its parent supplies one", () => {
    const onSave = vi.fn();
    render(<CaptureConfirm draft={captureProposal} saving={false} slot="meal-3"
      onSave={onSave} onDismiss={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "Save 1 item" }));
    expect(onSave).toHaveBeenCalledWith({}, false, "meal-3");
  });
});
