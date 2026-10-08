// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LogDraftBlock from "@/components/coach/blocks/log_draft";
import type {
  LogDraftBlockContext, LogDraftBlockV1,
} from "@/components/coach/blocks";
import { commitLogEntry } from "@/lib/log-commit-client";
import { localDateFor } from "@/lib/log/contract";
import { opIdFor } from "@/lib/log/op-id";
import { barcodeResponse, captureProposal } from "@/tests/coach/editors/fixtures";

vi.mock("@/lib/log-commit-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/log-commit-client")>(), commitLogEntry: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const barcodeBlock: LogDraftBlockV1 = {
  kind: "log_draft",
  v: 1,
  id: "barcode-block",
  source: "barcode",
  localDate: "2026-09-19",
  slot: "meal-2",
  draft: barcodeResponse,
  policy: { blocked: false },
  status: "pending",
};

function context(overrides: Partial<LogDraftBlockContext> = {}): LogDraftBlockContext {
  return {
    tz: "America/Denver",
    onBlockStatus: vi.fn(),
    onSearchManually: vi.fn(),
    rerunAsLabel: vi.fn(),
    ...overrides,
  };
}

describe("log_draft block", () => {
  it("passes the account day projection into the barcode portion editor", async () => {
    render(<LogDraftBlock block={barcodeBlock} ctx={context()} />);
    expect(await screen.findByText("Daily targets unavailable until your profile is complete.")).toBeTruthy();
  });
  it("leaves the edited pending draft committed, and then offers Undo", async () => {
    const commitBarcode = vi.fn().mockResolvedValue({
      entryIds: ["entry-1"], summary: "Plain rice crackers",
    });
    const onBlockStatus = vi.fn();
    const deleteEntry = vi.fn().mockResolvedValue(undefined);
    render(<LogDraftBlock block={barcodeBlock}
      ctx={context({ commitBarcode, onBlockStatus, deleteEntry })} />);

    fireEvent.click(screen.getByRole("button", { name: "Increase How many" }));
    fireEvent.click(screen.getByRole("button", { name: "Meal 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    await waitFor(() => expect(commitBarcode).toHaveBeenCalledTimes(1));
    const edits = commitBarcode.mock.calls[0][1];
    expect(edits).toMatchObject({ qty: 2, grams: 60, slot: "meal-3" });
    expect(await screen.findByText("Logged")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(onBlockStatus).toHaveBeenCalledWith("barcode-block", "committed", ["entry-1"]);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(deleteEntry).toHaveBeenCalledWith("2026-09-19", "entry-1"));
    expect(onBlockStatus).toHaveBeenLastCalledWith("barcode-block", "dismissed", undefined);
    expect(screen.getByText("Dismissed")).toBeTruthy();
    expect(screen.queryByText("Plain rice crackers")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("lets nothing else move the card while Log it is saving (UI audit 2026-10-07)", async () => {
    let land!: (value: { entryIds: string[]; summary: string }) => void;
    const commitBarcode = vi.fn(() => new Promise<{ entryIds: string[]; summary: string }>((resolve) => { land = resolve; }));
    const onBlockStatus = vi.fn();
    const onSearchManually = vi.fn();
    render(<LogDraftBlock block={barcodeBlock}
      ctx={context({ commitBarcode, onBlockStatus, onSearchManually })} />);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    await waitFor(() => expect(commitBarcode).toHaveBeenCalledOnce());
    const dismiss = screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement;
    const search = screen.getByRole("button", { name: "Search manually" }) as HTMLButtonElement;
    expect(dismiss.disabled).toBe(true);
    expect(search.disabled).toBe(true);
    fireEvent.click(dismiss);
    fireEvent.click(search);
    land({ entryIds: ["entry-1"], summary: "Plain rice crackers" });
    // The entry landed, so the card says so; it never claimed "Dismissed" in between.
    expect(await screen.findByText("Logged")).toBeTruthy();
    expect(onBlockStatus.mock.calls.map((call) => call[1])).toEqual(["committed"]);
    expect(onSearchManually).not.toHaveBeenCalled();
  });

  it("commits and undoes on one local date with a replay-stable entry id", async () => {
    const commit = vi.mocked(commitLogEntry);
    commit.mockResolvedValue({ status: "queued" });
    const first = render(<LogDraftBlock block={barcodeBlock} ctx={context()} />);

    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    const firstRequest = commit.mock.calls[0][0];
    expect(firstRequest.entry_id).toBe(opIdFor(barcodeBlock.id, undefined));
    expect(firstRequest.local_date).toBe(barcodeBlock.localDate);
    expect(localDateFor(firstRequest.eaten_at, firstRequest.tz)).toBe(barcodeBlock.localDate);

    first.unmount();
    const deleteEntry = vi.fn().mockResolvedValue(undefined);
    render(<LogDraftBlock block={barcodeBlock} ctx={context({ deleteEntry })} />);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    const replayRequest = commit.mock.calls[1][0];
    expect(replayRequest.entry_id).toBe(firstRequest.entry_id);
    expect(replayRequest.items[0].id).toBe(firstRequest.items[0].id);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(deleteEntry)
      .toHaveBeenCalledWith(barcodeBlock.localDate, firstRequest.entry_id));
  });

  it("stays pending when status persistence fails and retries without logging twice", async () => {
    const commitBarcode = vi.fn().mockResolvedValue({
      entryIds: ["entry-1"], summary: "Plain rice crackers",
    });
    const onBlockStatus = vi.fn()
      .mockRejectedValueOnce(new Error("thread write failed"))
      .mockResolvedValueOnce(undefined);
    render(<LogDraftBlock block={barcodeBlock}
      ctx={context({ commitBarcode, onBlockStatus })} />);

    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    expect((await screen.findByRole("status")).textContent).toContain("card status did not save");
    expect(screen.queryByText("Logged")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    expect(await screen.findByText("Logged")).toBeTruthy();
    expect(commitBarcode).toHaveBeenCalledOnce();
    expect(onBlockStatus).toHaveBeenCalledTimes(2);
  });

  it("shows only Search manually as an action when policy blocks the draft", () => {
    const onSearchManually = vi.fn();
    render(<LogDraftBlock block={{ ...barcodeBlock,
      policy: { blocked: true, reason: "category:fruit_pouches" } }}
      ctx={context({ onSearchManually })} />);

    expect(screen.getByText("On your avoid list: fruit pouches")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Search manually" }));
    expect(onSearchManually).toHaveBeenCalledWith(expect.objectContaining({ id: "barcode-block" }));
  });

  it("hands capture edits to the existing capture commit path", async () => {
    const commitCapture = vi.fn().mockResolvedValue({
      entryIds: ["entry-photo"], summary: "Roast chicken",
    });
    const block: LogDraftBlockV1 = {
      ...barcodeBlock,
      id: "capture-commit",
      source: "capture",
      method: "photo",
      draft: captureProposal,
    };
    render(<LogDraftBlock block={block} ctx={context({ commitCapture })} />);

    fireEvent.click(screen.getByRole("button", { name: "Increase Grams" }));
    fireEvent.click(screen.getByRole("button", { name: "Meal 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    await waitFor(() => expect(commitCapture).toHaveBeenCalledOnce());
    expect(commitCapture.mock.calls[0][1]).toMatchObject({
      items: { 1: { grams: 125, qty: 125, unit: "g", portionId: null } },
      slot: "meal-3",
    });
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("commits capture through the real capture client when no helper is injected", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(commitLogEntry).mockImplementation(async (request) => {
      await fetch("/api/log/commit", { method: "POST", body: JSON.stringify(request) });
      return { status: "queued" };
    });
    const block: LogDraftBlockV1 = {
      ...barcodeBlock,
      id: "capture-real-client",
      source: "capture",
      method: "photo",
      draft: captureProposal,
    };
    render(<LogDraftBlock block={block} ctx={context()} />);

    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request).toMatchObject({
      entry_id: opIdFor(block.id, undefined),
      method: "photo",
      draft_id: captureProposal.draftId,
      slot: "meal-2",
      items: [{ food_ref_id: captureProposal.items[0].foodRefId }],
    });
  });

  it("lets a blocked capture line be removed and logs the rest", async () => {
    const blockedRef = captureProposal.items[0].foodRefId as string;
    const proposal = {
      ...captureProposal,
      items: [
        { ...captureProposal.items[0], policy: { verdict: "blocked" as const, reason: "avoid_list" } },
        { ...captureProposal.items[0], seq: 2, label: "White rice",
          foodRefId: "55555555-5555-4555-8555-555555555555",
          policy: { verdict: "allowed" as const }, alternatives: [] },
      ],
    };
    const commitCapture = vi.fn().mockResolvedValue({
      entryIds: ["entry-photo"], summary: "White rice",
    });
    render(<LogDraftBlock block={{ ...barcodeBlock, source: "capture", method: "photo",
      draft: proposal, policy: { blocked: true, blockedItemIds: [blockedRef] } }}
      ctx={context({ commitCapture })} />);

    expect((screen.getByRole("button", { name: "Log it" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    await waitFor(() => expect(commitCapture).toHaveBeenCalledOnce());
    expect(commitCapture.mock.calls[0][1].items).toMatchObject({ 1: { removed: true } });
  });

  it("does not move focus from the composer when a photo draft renders", () => {
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    render(<LogDraftBlock block={{ ...barcodeBlock, source: "capture", method: "photo",
      draft: captureProposal }} ctx={context()} />);

    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it("renders a dismissed capture block as one line", () => {
    const { container } = render(<LogDraftBlock block={{ ...barcodeBlock, source: "capture",
      method: "photo", draft: captureProposal, status: "dismissed" }} ctx={context()} />);

    expect(container.textContent).toBe("Dismissed");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("degrades a photo missing from the store to a chip and keeps the label rerun affordance", () => {
    const block: LogDraftBlockV1 = {
      ...barcodeBlock,
      id: "capture-block",
      source: "capture",
      method: "photo",
      draft: captureProposal,
    };
    const rerunAsLabel = vi.fn();
    render(<LogDraftBlock block={block}
      ctx={context({ photoUrl: () => "/expired-photo.jpg", rerunAsLabel })} />);

    fireEvent.error(screen.getByRole("img", { name: "Photo attached" }));
    expect(screen.getByText("Photo attached")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "This was a nutrition label" }));
    expect(rerunAsLabel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "This was a nutrition label" })).toBeNull();
  });
});
