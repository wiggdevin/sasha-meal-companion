// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CoachShell from "@/components/coach/CoachShell";
import type { CoachAttachment } from "@/lib/coach/attachments";

/** U22 (2026-10-04): every turn from a dock page carries its page scope; /coach sends global. */

const mocks = vi.hoisted(() => ({ postTurn: vi.fn(), postAttachmentTurn: vi.fn() }));
vi.mock("@/lib/coach-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach-client")>(),
  postTurn: mocks.postTurn,
  postAttachmentTurn: mocks.postAttachmentTurn,
  getThread: vi.fn(() => new Promise(() => {})),
  readCache: () => ({ messages: [], actions: [] }),
  writeCache: vi.fn(),
}));

afterEach(() => { cleanup(); mocks.postTurn.mockReset(); mocks.postAttachmentTurn.mockReset(); });

const capture = { kind: "capture", v: 1, method: "photo", mediaPath: "u/1/p.jpg",
  localDate: "2026-10-04", slot: "meal-1" } as CoachAttachment;

describe("the scope a turn carries", () => {
  it("sends the page scope with a typed turn and with an attachment", async () => {
    mocks.postTurn.mockReturnValue(new Promise(() => {}));
    mocks.postAttachmentTurn.mockReturnValue(new Promise(() => {}));
    const scope = { kind: "page", page: "today", date: "2026-10-04" } as const;
    render(<CoachShell userId="user-1" threadId={null} scope={scope} fill="parent"
      onOpenDraft={() => undefined} onThreadSaved={() => undefined}
      toolbar={(controls) => <button type="button" onClick={() => void controls.sendAttachment(capture, "Sent a photo")}>
        Attach</button>} />);

    act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit", { detail: { text: "Move lunch to 1 pm" } })));
    await waitFor(() => expect(mocks.postTurn).toHaveBeenCalledTimes(1));
    expect(mocks.postTurn.mock.calls[0][0]).toMatchObject({ text: "Move lunch to 1 pm", scope });
    expect(screen.getByTestId("coach-shell").getAttribute("data-fill")).toBe("parent");
    cleanup();

    render(<CoachShell userId="user-1" threadId={null} scope={scope}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined}
      toolbar={(controls) => <button type="button" onClick={() => void controls.sendAttachment(capture, "Sent a photo")}>
        Attach</button>} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(mocks.postAttachmentTurn).toHaveBeenCalledTimes(1));
    expect(mocks.postAttachmentTurn.mock.calls[0][0]).toMatchObject({ attachment: capture, scope });
  });

  it("sends no scope key at all when none is given", async () => {
    mocks.postTurn.mockReturnValue(new Promise(() => {}));
    render(<CoachShell userId="user-1" threadId={null}
      onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
    act(() => window.dispatchEvent(new CustomEvent("coach:dock-submit", { detail: { text: "Hi" } })));
    await waitFor(() => expect(mocks.postTurn).toHaveBeenCalledTimes(1));
    expect("scope" in mocks.postTurn.mock.calls[0][0]).toBe(false);
  });
});
