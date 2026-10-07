// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesProvider } from "@/components/CapabilitiesProvider";
import CoachChat from "@/components/CoachChat";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";
import { barcodeResponse } from "@/tests/coach/editors/fixtures";
import { resetTestAccount } from "@/tests/helpers/account";


const block: LogDraftBlockV1 = {
  kind: "log_draft", v: 1, id: "live-barcode-block", source: "barcode",
  localDate: "2026-09-19", slot: "meal-2", draft: barcodeResponse,
  policy: { blocked: false }, status: "pending",
};

beforeEach(async () => {
  await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CoachChat live log draft", () => {
  it("uses the production commit and delete clients without handler injection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/coach") {
        return new Response(JSON.stringify({
          threadId: "4f1b1a2c-0000-4000-8000-000000000001",
          suggestions: [], actions: [], draft: null, deflected: false, toolsUsed: [],
          model: { provider: "gemini", modelId: "test" }, timings: { model: 1, ground: 1 },
          messages: [{ id: "assistant-1", role: "assistant", content: "Check it", seq: 2,
            createdAt: "2026-09-19T16:00:01.000Z", blocks: [block] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/log/commit") {
        return new Response(JSON.stringify({ error: "offline" }), {
          status: 503, headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CapabilitiesProvider value={{ coach: true, scan: false, captureMethods: [] }}>
      <CoachChat userId="user-1" threadId={null} onOpenDraft={vi.fn()} onThreadSaved={vi.fn()} />
    </CapabilitiesProvider>);

    // The dock is the one way into a turn now; this is the same event the dock's ask field uses.
    act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit",
      { detail: { text: "Log these crackers" } })));
    fireEvent.click(await screen.findByRole("button", { name: "Log it" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
      String(url) === "/api/log/commit")).toBe(true));
    expect(await screen.findByText("Logged")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Dismissed")).toBeTruthy();
  });
});
