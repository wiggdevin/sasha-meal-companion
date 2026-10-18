// @vitest-environment jsdom
/**
 * UI audit 2026-10-18 §6: the coach's scan sheet closes as soon as the scan is in the chat, and a
 * send the coach refuses (a reply still running) says so instead of hanging on "Looking it up…".
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ScanAttachmentSheet, { SCAN_REFUSED_COPY } from "@/components/coach/attachments/ScanAttachmentSheet";
import type { AttachmentSendOptions } from "@/components/coach/attachments/useAttachmentTurn";
import { barcodeResponse } from "@/tests/coach/editors/fixtures";

const scanner = vi.hoisted(() => ({
  result: null as unknown,
  taken: [] as unknown[],
}));

vi.mock("@/components/BarcodeScanSheet", () => ({
  default: ({ onResolved }: { onResolved: (value: unknown) => unknown }) => <div role="dialog" aria-label="Scan">
    <button type="button" onClick={() => { scanner.taken.push(onResolved(scanner.result)); }}>Decode</button>
  </div>,
}));

afterEach(() => {
  cleanup();
  scanner.taken.length = 0;
});

const resolved = {
  status: "resolved", gtin14: "00012345678905", cached: true,
  match: { ...barcodeResponse.match, description: "Rice crackers" },
};
const ambiguous = {
  status: "ambiguous", gtin14: barcodeResponse.gtin14, cached: false,
  matches: [barcodeResponse.match, { ...barcodeResponse.match, revisionId: 10, description: "Brown rice crackers" }],
};

describe("coach scan sheet", () => {
  it("closes once the scan is posted, without waiting on the reply", async () => {
    scanner.result = resolved;
    const onClose = vi.fn();
    const onAttachment = vi.fn((_a: unknown, _t: string, opts?: AttachmentSendOptions) => {
      opts?.onDispatched?.();
      return new Promise<boolean>(() => {});
    });
    render(<ScanAttachmentSheet open onClose={onClose} onAttachment={onAttachment} />);
    fireEvent.click(screen.getByRole("button", { name: "Decode" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("hands the scanner a refusal so it can scan again", async () => {
    scanner.result = resolved;
    const onClose = vi.fn();
    render(<ScanAttachmentSheet open onClose={onClose} onAttachment={async () => false} />);
    fireEvent.click(screen.getByRole("button", { name: "Decode" }));
    await expect(scanner.taken[0]).resolves.toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says a refused choice out loud and lets the row be tapped again", async () => {
    scanner.result = ambiguous;
    const onAttachment = vi.fn(async () => false);
    render(<ScanAttachmentSheet open onClose={vi.fn()} onAttachment={onAttachment} />);
    fireEvent.click(screen.getByRole("button", { name: "Decode" }));
    const row = screen.getByRole("button", { name: /plain rice crackers/i });
    fireEvent.click(row);
    expect(await screen.findByText(SCAN_REFUSED_COPY)).toBeTruthy();
    await waitFor(() => expect((row as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(row);
    await waitFor(() => expect(onAttachment).toHaveBeenCalledTimes(2));
  });

  it("shows the rows as pending while the send runs", () => {
    scanner.result = ambiguous;
    render(<ScanAttachmentSheet open onClose={vi.fn()} onAttachment={() => new Promise<boolean>(() => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "Decode" }));
    const row = screen.getByRole("button", { name: /plain rice crackers/i });
    fireEvent.click(row);
    expect(screen.getByText("Sending…")).toBeTruthy();
    expect((row as HTMLButtonElement).disabled).toBe(true);
  });
});
