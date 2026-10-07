// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import {
  COACH_DOCK_ATTACH_EVENT, DockIntentReceiver, DockScanReceiver,
} from "@/components/coach/attachments/dock-handoff";
import { CoachMessageExtras } from "@/components/CoachChat";
import CoachShell from "@/components/coach/CoachShell";
import type { CoachAttachment } from "@/lib/coach/attachments";
import { postAttachmentTurn } from "@/lib/coach-client";
import type { CoachMessageView } from "@/lib/coach/message-view";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";
import { captureProposal } from "@/tests/coach/editors/fixtures";
import { barcodeResponse } from "@/tests/coach/editors/fixtures";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const mocks = vi.hoisted(() => ({
  scannerResult: { current: null as null | Record<string, unknown> },
  upload: vi.fn(),
  resize: vi.fn(),
}));

vi.mock("@/components/BarcodeScanSheet", () => ({
  default: ({ onResolved, onClose }: {
    onResolved: (value: unknown) => void;
    onClose: () => void;
  }) => <div role="dialog" aria-label="Scan">
    <button type="button" onClick={() => onResolved(mocks.scannerResult.current)}>Decode</button>
    <button type="button" onClick={onClose}>Close scan</button>
  </div>,
}));

vi.mock("@/lib/media/resize", () => ({ resizeImage: mocks.resize }));
vi.mock("@/lib/capture-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/capture-client")>(),
  signAndUpload: mocks.upload,
}));

/** Stands in for the dock's own `scanOpen` state (CoachChat), open from the start: these tests
 *  are about the sheet DockScanReceiver wraps, not the Scan-tile tap that opens it (tabbar tests
 *  cover that trigger). */
function ScanHarness({ onAttachment, onSearchManually }: {
  onAttachment: (attachment: CoachAttachment, optimisticText: string) => void | Promise<boolean>;
  onSearchManually?: (description: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return <DockScanReceiver open={open} onClose={() => setOpen(false)}
    onAttachment={onAttachment} onSearchManually={onSearchManually} />;
}

const response = (messages: CoachMessageView[] = []) => new Response(JSON.stringify({
  threadId: "4f1b1a2c-0000-4000-8000-000000000001",
  suggestions: [], actions: [], messages, draft: null, deflected: false, toolsUsed: [],
  model: { provider: "gemini", modelId: "" }, timings: { model: 0, ground: 0 },
}), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  mocks.scannerResult.current = null;
  mocks.upload.mockReset();
  mocks.resize.mockReset();
});

describe("coach attachment turns", () => {
  it("posts an empty-text barcode attachment with a fresh message id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response());
    const messageId = "3f1b1a2c-0000-4000-8000-000000000010";
    const attachment: CoachAttachment = {
      kind: "barcode", v: 1, gtin14: "00012345678905",
      foodRefId: "3f1b1a2c-0000-4000-8000-000000000011", revisionId: "71",
      localDate: "2026-09-19", slot: "meal-2", scannedAt: "2026-09-19T16:00:00.000Z",
    };

    await postAttachmentTurn({ threadId: null, messageId, text: "", attachment }, { fetchImpl });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ threadId: null, messageId, text: "", attachment });
  });

  it("generates the message id and shows the optimistic scanned-food bubble", async () => {
    const pending = new Promise<Response>(() => {});
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000012");
    const attachment: CoachAttachment = {
      kind: "barcode", v: 1, gtin14: "00012345678905",
      foodRefId: "3f1b1a2c-0000-4000-8000-000000000011", revisionId: "71",
      localDate: "2026-09-19", scannedAt: "2026-09-19T16:00:00.000Z",
    };
    render(<CoachShell userId="user-1" threadId={null} onOpenDraft={vi.fn()}
      onThreadSaved={vi.fn()} toolbar={(controls) => (
        <button type="button" onClick={() => controls.sendAttachment(attachment, "Scanned Rice crackers")}>Attach</button>
      )} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.getByText("Scanned Rice crackers")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messageId).toBe("3f1b1a2c-0000-4000-8000-000000000012");
    expect(body.text).toBe("");
  });

  it("sends a resolved scan and never posts a not-found scan", () => {
    const onAttachment = vi.fn();
    mocks.scannerResult.current = {
      status: "resolved", gtin14: "00012345678905", cached: false,
      match: { foodRefId: "3f1b1a2c-0000-4000-8000-000000000011", revisionId: 71,
        description: "Rice crackers" },
    };
    const view = render(<ScanHarness onAttachment={onAttachment} />);
    fireEvent.click(screen.getByRole("button", { name: "Decode" }));
    expect(onAttachment).toHaveBeenCalledWith(expect.objectContaining({
      kind: "barcode", v: 1, gtin14: "00012345678905", revisionId: "71",
    }), "Scanned Rice crackers");

    cleanup();
    onAttachment.mockClear();
    mocks.scannerResult.current = {
      status: "not_found", gtin14: "00012345678905", searchHint: { name: "Unknown" },
    };
    render(<ScanHarness onAttachment={onAttachment} onSearchManually={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Decode" }));
    expect(screen.getByText(/do not know this barcode/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search manually" }));
    expect(screen.getByRole("searchbox", { name: "Search foods" })).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onAttachment).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps an offline decoded barcode as one pending retryable turn", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    mocks.scannerResult.current = {
      status: "resolved", gtin14: "00012345678905", cached: true,
      match: { foodRefId: "3f1b1a2c-0000-4000-8000-000000000011", revisionId: 71,
        description: "Rice crackers" },
    };
    render(<CoachShell userId="user-1" threadId={null} onOpenDraft={vi.fn()}
      onThreadSaved={vi.fn()} toolbar={(controls) => (
        <DockScanReceiver open onClose={() => {}}
          onAttachment={controls.sendAttachment} />
      )} />);

    fireEvent(window, new Event("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Decode" }));

    expect(await screen.findByText("Scanned Rice crackers")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Scan" })).toBeTruthy();
    expect(screen.getAllByText("Scanned Rice crackers")).toHaveLength(1);
  });

  it("claims an ambiguous barcode choice before the first attachment callback", () => {
    const onAttachment = vi.fn();
    mocks.scannerResult.current = {
      status: "ambiguous", gtin14: barcodeResponse.gtin14, cached: false,
      matches: [barcodeResponse.match, { ...barcodeResponse.match, revisionId: 10,
        description: "Brown rice crackers" }],
    };
    render(<ScanHarness onAttachment={onAttachment} />);
    fireEvent.click(screen.getByRole("button", { name: "Decode" }));
    const choice = screen.getByRole("button", { name: /plain rice crackers/i });

    choice.click();
    choice.click();

    expect(onAttachment).toHaveBeenCalledOnce();
  });

  it("uploads a dock-handed photo, then the card reruns the same media once as label", async () => {
    // Camera/Upload moved wholesale into the dock's own tray (PR #296); this is what actually
    // performs the upload once AssistantField hands the picked file over as a dock-attach intent.
    const onAttachment = vi.fn();
    const photo = new Blob(["photo"], { type: "image/jpeg" });
    mocks.resize.mockResolvedValue(photo);
    mocks.upload.mockResolvedValue({ kind: "uploaded",
      path: "media/3f1b1a2c-0000-4000-8000-000000000001/3f1b1a2c-0000-4000-8000-000000000002.jpg" });
    render(<DockIntentReceiver ready onAttachment={onAttachment} />);
    const file = new File(["source"], "plate.jpg", { type: "image/jpeg" });
    await act(async () => window.dispatchEvent(new CustomEvent(COACH_DOCK_ATTACH_EVENT,
      { detail: { kind: "photo", file } })));
    await waitFor(() => expect(onAttachment).toHaveBeenCalledWith(expect.objectContaining({
      kind: "capture", v: 1, method: "photo",
      mediaPath: "media/3f1b1a2c-0000-4000-8000-000000000001/3f1b1a2c-0000-4000-8000-000000000002.jpg",
    }), "Sent a photo"));

    cleanup();
    const mediaPath = "media/3f1b1a2c-0000-4000-8000-000000000001/3f1b1a2c-0000-4000-8000-000000000002.jpg";
    const user: CoachMessageView = { id: "u", role: "user", content: "Sent a photo", seq: 1,
      createdAt: "2026-09-19T16:00:00.000Z",
      attachments: [{ kind: "capture", v: 1, method: "photo", mediaPath, localDate: "2026-09-19" }] };
    const block: LogDraftBlockV1 = { kind: "log_draft", v: 1, id: "b", source: "capture",
      method: "photo", localDate: "2026-09-19", draft: captureProposal,
      policy: { blocked: false }, status: "pending" };
    const assistant: CoachMessageView = { id: "a", role: "assistant", content: "Check it", seq: 2,
      createdAt: "2026-09-19T16:00:01.000Z", blocks: [block] };
    render(<CoachMessageExtras message={assistant} messages={[user, assistant]}
      tz="America/Denver" onAttachment={onAttachment} onSearchManually={vi.fn()}
      onBlockStatus={vi.fn()} />);
    const rerun = screen.getByRole("button", { name: "This was a nutrition label" });
    fireEvent.click(rerun);
    expect(onAttachment).toHaveBeenLastCalledWith({
      kind: "capture", v: 1, method: "label", mediaPath, localDate: "2026-09-19",
    }, "Sent a label photo");
    expect(screen.queryByRole("button", { name: "This was a nutrition label" })).toBeNull();
  });

  it("retries a failed dock photo upload with the same file", async () => {
    // Grok audit 2026-10-02, finding 4: CaptureStatusSheet already supported onRetry (the deleted
    // CameraAttachmentButton passed one), but DockIntentReceiver never wired it up, so a failed
    // upload from the dock's Camera/Upload tiles had no way to try again.
    const onAttachment = vi.fn();
    mocks.resize.mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" }));
    mocks.upload.mockResolvedValueOnce({ kind: "failed", outcome: { kind: "error", status: 0, message: "Try again." } });
    mocks.upload.mockResolvedValueOnce({ kind: "uploaded", path: "media/retry/ok.jpg" });
    render(<DockIntentReceiver ready onAttachment={onAttachment} />);
    const file = new File(["source"], "plate.jpg", { type: "image/jpeg" });
    await act(async () => window.dispatchEvent(new CustomEvent(COACH_DOCK_ATTACH_EVENT,
      { detail: { kind: "photo", file } })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onAttachment).toHaveBeenCalledWith(expect.objectContaining({
      mediaPath: "media/retry/ok.jpg",
    }), "Sent a photo"));
    expect(mocks.upload).toHaveBeenCalledTimes(2);
  });

  it("refuses a label rerun when the preceding attachment was not a photo", () => {
    const onAttachment = vi.fn();
    const mediaPath = "media/3f1b1a2c-0000-4000-8000-000000000001/3f1b1a2c-0000-4000-8000-000000000002.jpg";
    const user: CoachMessageView = { id: "u", role: "user", content: "Sent a label photo", seq: 1,
      createdAt: "2026-09-19T16:00:00.000Z",
      attachments: [{ kind: "capture", v: 1, method: "label", mediaPath, localDate: "2026-09-19" }] };
    const block: LogDraftBlockV1 = { kind: "log_draft", v: 1, id: "b", source: "capture",
      method: "photo", localDate: "2026-09-19", draft: captureProposal,
      policy: { blocked: false }, status: "pending" };
    const assistant: CoachMessageView = { id: "a", role: "assistant", content: "Check it", seq: 2,
      createdAt: "2026-09-19T16:00:01.000Z", blocks: [block] };
    render(<CoachMessageExtras message={assistant} messages={[user, assistant]}
      tz="America/Denver" onAttachment={onAttachment} onSearchManually={vi.fn()}
      onBlockStatus={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "This was a nutrition label" }));

    expect(onAttachment).not.toHaveBeenCalled();
    expect(screen.getByText("Can’t rerun — take the photo again")).toBeTruthy();
  });
});
