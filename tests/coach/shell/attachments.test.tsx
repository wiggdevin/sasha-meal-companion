// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { CoachMessageExtras } from "@/components/CoachChat";
import CoachShell from "@/components/coach/CoachShell";
import type { CoachAttachment } from "@/lib/coach/attachments";
import { CoachError } from "@/lib/coach-client";
import type { CoachMessageView } from "@/lib/coach/message-view";
import type { CoachTurnResponse } from "@/lib/coach/types";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";
import { barcodeResponse, captureProposal } from "@/tests/coach/editors/fixtures";

const mocks = vi.hoisted(() => ({
  postAttachmentTurn: vi.fn(),
  postTurn: vi.fn(),
  writeCache: vi.fn(),
}));

vi.mock("@/lib/coach-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach-client")>(),
  fetchOlder: vi.fn(),
  getThread: vi.fn(),
  postAttachmentTurn: mocks.postAttachmentTurn,
  postTurn: mocks.postTurn,
  readCache: () => ({ messages: [], actions: [] }),
  writeCache: mocks.writeCache,
}));

const mediaPath = "media/3f1b1a2c-0000-4000-8000-000000000001/3f1b1a2c-0000-4000-8000-000000000002.jpg";
const photo: CoachAttachment = {
  kind: "capture", v: 1, method: "photo", mediaPath, localDate: "2026-09-19",
};
const barcode: CoachAttachment = {
  kind: "barcode", v: 1, gtin14: barcodeResponse.gtin14,
  foodRefId: barcodeResponse.match.foodRefId, revisionId: String(barcodeResponse.match.revisionId),
  localDate: "2026-09-19", scannedAt: "2026-09-19T16:00:00.000Z",
};
const block: LogDraftBlockV1 = {
  kind: "log_draft", v: 1, id: "photo-block", source: "capture", method: "photo",
  localDate: "2026-09-19", draft: captureProposal, policy: { blocked: false }, status: "pending",
};

function turn(messages: CoachTurnResponse["messages"], threadId = "4f1b1a2c-0000-4000-8000-000000000001"):
CoachTurnResponse {
  return {
    threadId, suggestions: [], actions: [], messages, draft: null, deflected: false, toolsUsed: [],
    model: { provider: "gemini", modelId: "" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Phase 9 §0.4: the shell caches the transcript for the account it was rendered for.
beforeEach(() => { unbindAccount(); bindAccount("user-1"); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.postAttachmentTurn.mockReset();
  mocks.postTurn.mockReset();
  mocks.writeCache.mockReset();
});

describe("coach shell attachment state", () => {
  it("keeps the barcode user row when the assistant-only reply renders its log draft", async () => {
    const barcodeBlock: LogDraftBlockV1 = {
      kind: "log_draft", v: 1, id: "barcode-block", source: "barcode",
      localDate: "2026-09-19", draft: barcodeResponse,
      policy: { blocked: false }, status: "pending",
    };
    mocks.postAttachmentTurn.mockResolvedValue(turn([
      { id: "assistant-2", role: "assistant", content: "Check it", seq: 2, blocks: [barcodeBlock] },
    ]));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000010");
    render(<CoachShell userId="user-1" threadId={null} onOpenDraft={vi.fn()}
      onThreadSaved={vi.fn()} toolbar={(controls) => <button type="button"
        onClick={() => controls.sendAttachment(barcode, "Scanned Plain rice crackers")}>Scan</button>}
      renderExtras={(message, controls, messages) => <CoachMessageExtras
        message={message as CoachMessageView} messages={messages as CoachMessageView[]}
        tz="America/Denver" onAttachment={controls.sendAttachment}
        onBlockStatus={controls.onBlockStatus} onSearchManually={vi.fn()} />} />);

    fireEvent.click(screen.getByRole("button", { name: "Scan" }));

    expect(await screen.findByRole("button", { name: "Log it" })).toBeTruthy();
    expect(screen.getByText("Scanned Plain rice crackers")).toBeTruthy();
    expect(mocks.postAttachmentTurn).toHaveBeenCalledOnce();
  });

  it("keeps a photo on the user row and reruns the same media path once as label", async () => {
    const first = deferred<CoachTurnResponse>();
    const second = deferred<CoachTurnResponse>();
    mocks.postAttachmentTurn.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("3f1b1a2c-0000-4000-8000-000000000010")
      .mockReturnValueOnce("3f1b1a2c-0000-4000-8000-000000000011");
    render(<CoachShell userId="user-1" threadId={null} onOpenDraft={vi.fn()}
      onThreadSaved={vi.fn()} toolbar={(controls) => <button type="button"
        onClick={() => controls.sendAttachment(photo, "Sent a photo")}>Attach photo</button>}
      renderExtras={(message, controls, messages) => <CoachMessageExtras
        message={message as CoachMessageView} messages={messages as CoachMessageView[]}
        tz="America/Denver" onAttachment={controls.sendAttachment}
        onBlockStatus={controls.onBlockStatus} onSearchManually={vi.fn()} />} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach photo" }));
    await act(async () => first.resolve(turn([
      { id: "assistant-2", role: "assistant", content: "Check it", seq: 2, blocks: [block] },
    ])));
    fireEvent.click(screen.getByRole("button", { name: "This was a nutrition label" }));

    await waitFor(() => expect(mocks.postAttachmentTurn).toHaveBeenCalledTimes(2));
    expect(mocks.postAttachmentTurn.mock.calls[1][0]).toMatchObject({
      messageId: "3f1b1a2c-0000-4000-8000-000000000011",
      attachment: { kind: "capture", method: "label", mediaPath },
    });
    await act(async () => second.resolve(turn([
      { id: "assistant-4", role: "assistant", content: "Label ready", seq: 4,
        blocks: [{ ...block, id: "label-block", method: "label" }] },
    ])));
    expect(screen.queryByRole("button", { name: "This was a nutrition label" })).toBeNull();
  });

  it("persists live card status and entry ids through committed then dismissed", async () => {
    mocks.postAttachmentTurn.mockResolvedValue(turn([
      { id: "assistant-2", role: "assistant", content: "Check it", seq: 2, blocks: [block] },
    ]));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000010");
    const commitCapture = vi.fn().mockResolvedValue({ entryIds: ["entry-1"], summary: "Chicken" });
    const deleteEntry = vi.fn().mockResolvedValue(undefined);
    render(<CoachShell userId="user-1" threadId={null} onOpenDraft={vi.fn()}
      onThreadSaved={vi.fn()} toolbar={(controls) => <button type="button"
        onClick={() => controls.sendAttachment(photo, "Sent a photo")}>Attach photo</button>}
      renderExtras={(message, controls, messages) => <CoachMessageExtras
        message={message as CoachMessageView} messages={messages as CoachMessageView[]}
        tz="America/Denver" onAttachment={controls.sendAttachment}
        onBlockStatus={controls.onBlockStatus} onSearchManually={vi.fn()}
        commitCapture={commitCapture} deleteEntry={deleteEntry} />} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach photo" }));
    await screen.findByRole("button", { name: "Log it" });

    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    await screen.findByText("Logged");
    await waitFor(() => expect(mocks.writeCache).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }),
      "4f1b1a2c-0000-4000-8000-000000000001",
      expect.objectContaining({ messages: expect.arrayContaining([
        expect.objectContaining({ blocks: [expect.objectContaining({
          id: "photo-block", status: "committed", entryIds: ["entry-1"],
        })] }),
      ]) })));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Dismissed");
    expect(deleteEntry).toHaveBeenCalledWith("2026-09-19", "entry-1");
    await waitFor(() => expect(mocks.writeCache).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "user-1" }),
      "4f1b1a2c-0000-4000-8000-000000000001",
      expect.objectContaining({ messages: expect.arrayContaining([
        expect.objectContaining({ blocks: [expect.objectContaining({
          id: "photo-block", status: "dismissed",
        })] }),
      ]) })));
  });

  it("retries a 503 attachment failure with the same message id and attachment", async () => {
    mocks.postAttachmentTurn.mockRejectedValueOnce(new CoachError(503, "timeout", "Try again."))
      .mockResolvedValueOnce(turn([]));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000010");
    render(<CoachShell userId="user-1" threadId={null} onOpenDraft={vi.fn()}
      onThreadSaved={vi.fn()} toolbar={(controls) => <button type="button"
        onClick={() => controls.sendAttachment(photo, "Sent a photo")}>Attach photo</button>} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach photo" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getAllByText("Sent a photo")).toHaveLength(1);
    fireEvent.click(retry);

    await waitFor(() => expect(mocks.postAttachmentTurn).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("Sent a photo")).toHaveLength(1);
    expect(mocks.postAttachmentTurn.mock.calls[1][0]).toEqual(mocks.postAttachmentTurn.mock.calls[0][0]);
    expect(mocks.postTurn).not.toHaveBeenCalled();
  });

  it("retries the newest failed text turn rather than an older failed attachment", async () => {
    mocks.postTurn.mockResolvedValueOnce(turn([
      { id: "first-user", role: "user", content: "Hello", seq: 1 },
      { id: "first-reply", role: "assistant", content: "Hi", seq: 2 },
    ])).mockRejectedValueOnce(new CoachError(503, "timeout", "Try again."))
      .mockReturnValueOnce(new Promise(() => {}));
    mocks.postAttachmentTurn.mockRejectedValueOnce(new CoachError(503, "timeout", "Try again."));
    render(<CoachShell userId="user-1" threadId={null} onOpenDraft={vi.fn()}
      onThreadSaved={vi.fn()} toolbar={(controls) => <button type="button"
        onClick={() => controls.sendAttachment(photo, "Sent a photo")}>Attach photo</button>} />);

    act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit", { detail: { text: "Hello" } })));
    await screen.findByText("Hi");
    fireEvent.click(screen.getByRole("button", { name: "Attach photo" }));
    await screen.findByRole("button", { name: "Try again" });
    act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit",
      { detail: { text: "Tell me more" } })));
    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.postTurn).toHaveBeenCalledTimes(3));
    expect(mocks.postAttachmentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.postTurn.mock.calls[2][0].messageId).toBe(mocks.postTurn.mock.calls[1][0].messageId);
  });

  it("uses the attachment error status and retry delay", async () => {
    mocks.postAttachmentTurn.mockRejectedValue(new CoachError(429, "rate_limited", "Raw error", 120));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("3f1b1a2c-0000-4000-8000-000000000010");
    render(<CoachShell userId="user-1" threadId={null} onOpenDraft={vi.fn()}
      onThreadSaved={vi.fn()} toolbar={(controls) => <button type="button"
        onClick={() => controls.sendAttachment(photo, "Sent a photo")}>Attach photo</button>} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach photo" }));

    expect(await screen.findByText("That is enough turns with Sasha for now. Try again in 2 minutes."))
      .toBeTruthy();
  });
});
