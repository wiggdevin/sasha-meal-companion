// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CoachShell from "@/components/coach/CoachShell";
import { withServerUndos } from "@/components/coach/server-undo";
import { writeStoredTasteChips } from "@/components/coach/taste-chips-storage";
import type { CoachAction } from "@/lib/coach/actions";
import type { ChatAction, ChatMessage } from "@/lib/coach/chat-state";
import type { CoachUndoView } from "@/lib/coach/undo-client";

/** C4: Undo on a device that never applied the action, and a composed card's source on apply. */

const THREAD = "3f1b1a2c-0000-4000-8000-000000000001";
const MESSAGE = "3f1b1a2c-0000-4000-8000-0000000000aa";
const water = { kind: "log_water", actionId: "act-1", flagged: [], ml: 500 } as unknown as CoachAction;
const saved: ChatMessage & { actions: CoachAction[] } = {
  id: MESSAGE, role: "assistant", content: "Logged your water.", seq: 2, actions: [water] };

function record(over: Partial<CoachUndoView> = {}): CoachUndoView {
  return { id: "rec-1", actionId: "act-1", kind: "log_water", threadId: THREAD, messageId: MESSAGE,
    createdAt: "2026-10-05T12:00:00Z", expiresAt: "2026-10-12T12:00:00Z", undoneAt: null,
    expired: false, serverUndoable: true,
    card: { type: "generic", kind: over.kind ?? "log_water", title: "Coach change" }, ...over };
}

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(), listCoachUndos: vi.fn(), undoCoachAction: vi.fn(), applyCoachAction: vi.fn(),
  undoTasteChips: vi.fn(),
  cache: { messages: [] as unknown[], actions: [] as unknown[] },
}));
const account = { userId: "user-1", epoch: 1 };
vi.mock("@/lib/device/account", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/device/account")>(),
  currentAccountOrNull: () => account, isCurrent: () => true,
}));
vi.mock("@/lib/coach-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach-client")>(),
  getThread: mocks.getThread, readCache: () => mocks.cache, writeCache: vi.fn(),
}));
vi.mock("@/lib/coach/undo-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach/undo-client")>(),
  listCoachUndos: mocks.listCoachUndos,
}));
vi.mock("@/lib/coach/apply-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach/apply-client")>(),
  undoCoachAction: mocks.undoCoachAction, applyCoachAction: mocks.applyCoachAction,
}));
vi.mock("@/lib/profile/taste-confirm-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/profile/taste-confirm-client")>(),
  undoTasteChips: mocks.undoTasteChips,
}));

afterEach(() => {
  cleanup();
  for (const fn of [mocks.getThread, mocks.listCoachUndos, mocks.undoCoachAction, mocks.applyCoachAction,
    mocks.undoTasteChips]) fn.mockReset();
  mocks.cache = { messages: [], actions: [] };
  localStorage.clear();
});

function open() {
  mocks.getThread.mockResolvedValue({ thread: { id: THREAD, title: null, kind: "chat", lastMessageAt: null },
    messages: [saved], cleared: true });
  render(<CoachShell userId="user-1" threadId={THREAD} onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);
}

describe("withServerUndos", () => {
  it("adds a server-held card drawn from the record's own card, never from the saved action", () => {
    const [entry] = withServerUndos([saved], [], [record()], {});
    expect(entry).toMatchObject({ status: "applied", messageId: MESSAGE, serverUndoable: true,
      server: { card: { type: "generic", kind: "log_water", title: "Coach change" }, createdAt: "2026-10-05T12:00:00Z" } });
    expect(entry.action).toEqual({ kind: "log_water", actionId: "act-1", flagged: [] });
    expect(entry.action).not.toBe(water);
    expect(entry.token).toBeUndefined();
  });

  it("shows a record whose action no saved message carries (a composed card's tap), and no card without a record", () => {
    expect(withServerUndos([saved], [], [record({ actionId: "tap-1" })], {})).toMatchObject([
      { action: { actionId: "tap-1" }, messageId: MESSAGE, server: { card: { title: "Coach change" } } }]);
    expect(withServerUndos([saved], [], [], {})).toEqual([]);
  });

  it("offers no server Undo for an expired or phone-only record", () => {
    expect(withServerUndos([saved], [], [record({ expired: true })], {})[0].serverUndoable).toBeUndefined();
    expect(withServerUndos([saved], [], [record({ serverUndoable: false })], {})[0].serverUndoable).toBeUndefined();
  });

  it("puts a receipt card under its source message only when the receipt names one", () => {
    const receipt = (messageId: string | null, sourceCheck: "match" | "mismatch") => record({
      kind: "log_meal", card: { type: "receipt", kind: "log_meal", title: "Logged Meal 3 on Mon 5 Oct",
        lines: [{ name: "Eggs", grams: 100 }], date: "2026-10-05", slot: "meal-3", messageId, sourceCheck,
        complete: true } });
    expect(withServerUndos([saved], [], [receipt(MESSAGE, "match")], {})[0].messageId).toBe(MESSAGE);
    // The record still names the message it was posted from, but an unmatched receipt never claims it.
    expect(withServerUndos([saved], [], [receipt(null, "mismatch")], {})[0].messageId).toBeNull();
  });

  it("waits for a record's message to load, and lists each record once, oldest first", () => {
    expect(withServerUndos([], [], [record()], {})).toEqual([]);
    const newer = record({ id: "rec-2", actionId: "act-2", createdAt: "2026-10-05T13:00:00Z" });
    const shown = withServerUndos([saved], [], [newer, record(), record()], {});
    expect(shown.map((entry) => entry.action.actionId)).toEqual(["act-1", "act-2"]);
  });

  it("leaves out a taste-chip record once THIS device's own inline card already rests on it", () => {
    // The message's own TasteChipsCard (CoachChat's renderExtras, keyed off message.tasteChips)
    // already reads and writes this exact action's state once this device has a resting local
    // record for it -- a second, separately-sourced card here would drift out of sync with it the
    // moment either one is acted on (Sol r3 BLOCK, "inline vs Undo-list state not synced").
    const withChips = { ...saved, tasteChips: { id: "proposal-1" } } as unknown as ChatMessage;
    const taste = record({ id: "rec-taste", actionId: "act-taste", kind: "confirm_taste_chips",
      card: { type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
        added: { dislikes: ["f:mushroom"], cuisines: [] }, complete: true } });
    writeStoredTasteChips(account, "proposal-1",
      { actionId: "act-taste", dislikes: ["f:mushroom"], cuisines: [], status: "applied" });
    expect(withServerUndos([withChips], [], [taste], {}, account)).toEqual([]);
  });

  it("still shows a taste-chip record when its message carries no tasteChips (a legacy or trimmed message)", () => {
    const taste = record({ id: "rec-taste", actionId: "act-taste", kind: "confirm_taste_chips",
      card: { type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
        added: { dislikes: ["f:mushroom"], cuisines: [] }, complete: true } });
    const shown = withServerUndos([saved], [], [taste], {}, account);
    expect(shown.map((entry) => entry.action.actionId)).toEqual(["act-taste"]);
  });

  it("still shows a taste-chip record on a device with NO local resolution yet, so Undo stays reachable", () => {
    // A second device (or a fresh install, or cleared storage) never tapped Add here: the inline
    // card renders idle/unconfirmed, with no Undo of its own. Sol r4 BLOCK on the unconditional
    // version of this fix: it skipped the record regardless, silently dropping the only Undo path
    // this device had for an action another device already confirmed (verified).
    const withChips = { ...saved, tasteChips: { id: "proposal-1" } } as unknown as ChatMessage;
    const taste = record({ id: "rec-taste", actionId: "act-taste", kind: "confirm_taste_chips",
      card: { type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
        added: { dislikes: ["f:mushroom"], cuisines: [] }, complete: true } });
    const shown = withServerUndos([withChips], [], [taste], {}, account);
    expect(shown.map((entry) => entry.action.actionId)).toEqual(["act-taste"]);
    expect(shown[0].serverUndoable).toBe(true);
  });

  it("still shows a NEWER action's record on the same proposal, despite an older resolved action in local storage", () => {
    // The same proposal can be confirmed more than once over time with a different action id each
    // time (a fresh tap after an Undo, or on another device). This device's stored resolution is
    // for an OLDER action on this proposal; it must not be read as covering a newer one, or that
    // newer action's own server card -- its only Undo path here -- would silently disappear
    // (Sol r5 BLOCK on matching by proposal id alone, verified).
    const withChips = { ...saved, tasteChips: { id: "proposal-1" } } as unknown as ChatMessage;
    writeStoredTasteChips(account, "proposal-1",
      { actionId: "act-old", dislikes: ["f:mushroom"], cuisines: [], status: "undone" });
    const taste = record({ id: "rec-taste-2", actionId: "act-new", kind: "confirm_taste_chips",
      card: { type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
        added: { dislikes: ["f:cilantro"], cuisines: [] }, complete: true } });
    const shown = withServerUndos([withChips], [], [taste], {}, account);
    expect(shown.map((entry) => entry.action.actionId)).toEqual(["act-new"]);
  });

  it("still shows a taste-chip record while this device's own card only has a PENDING local entry", () => {
    // A tap in flight (or lost mid-request) is not a resting state -- it never shows as a resolved
    // inline card, so the server-held copy stays the reachable Undo path until it does.
    const withChips = { ...saved, tasteChips: { id: "proposal-1" } } as unknown as ChatMessage;
    const taste = record({ id: "rec-taste", actionId: "act-taste", kind: "confirm_taste_chips",
      card: { type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
        added: { dislikes: ["f:mushroom"], cuisines: [] }, complete: true } });
    writeStoredTasteChips(account, "proposal-1",
      { actionId: "act-taste", dislikes: ["f:mushroom"], cuisines: [], status: "pending" });
    const shown = withServerUndos([withChips], [], [taste], {}, account);
    expect(shown.map((entry) => entry.action.actionId)).toEqual(["act-taste"]);
  });

  it("keeps this phone's own card for an action it holds the token for", () => {
    const local: ChatAction = { action: water, status: "applied", messageId: MESSAGE,
      token: { kind: "log_water", date: "2026-10-05", cups: 2 } as unknown as ChatAction["token"] };
    const shown = withServerUndos([saved], [local], [record()], {});
    expect(shown).toHaveLength(1);
    expect(shown[0].action).toBe(water);
    expect(shown[0].server).toBeUndefined();
  });

  it("marks this phone's applied entry undone when another device undid it", () => {
    const local: ChatAction = { action: water, status: "applied", messageId: MESSAGE,
      token: { kind: "log_water", date: "2026-10-05", cups: 2 } as unknown as ChatAction["token"] };
    const [entry] = withServerUndos([saved], [local], [record({ undoneAt: "2026-10-05T13:00:00Z" })], {});
    expect(entry.status).toBe("undone");
    expect(entry.token).toBeUndefined();
  });

  it("carries the already-undone flag from this phone's own undo progress (t23 #8)", () => {
    const [entry] = withServerUndos([saved], [], [record({ undoneAt: "2026-10-05T13:00:00Z" })],
      { "act-1": { status: "undone", already: true } });
    expect(entry).toMatchObject({ status: "undone", already: true });
  });

  it("shows the server's undone over a local Undo that timed out", () => {
    const local: ChatAction = { action: water, status: "failed", messageId: MESSAGE,
      reason: "That undo may not have finished. Try again.",
      token: { kind: "log_water", date: "2026-10-05", cups: 2 } as unknown as ChatAction["token"] };
    const [entry] = withServerUndos([saved], [local], [record({ undoneAt: "2026-10-05T13:00:00Z" })], {});
    expect(entry).toMatchObject({ status: "undone" });
    expect(entry.reason).toBeUndefined();
  });
});

describe("TASTE_CHIPS_ENABLED off: an empty Undo list", () => {
  it("renders exactly as on main — the saved message and nothing taste-related or server-held", async () => {
    mocks.listCoachUndos.mockResolvedValue([]);
    open();
    await screen.findByText("Logged your water.");
    expect(mocks.listCoachUndos).toHaveBeenCalledWith(account, { threadId: THREAD });
    expect(document.querySelectorAll("[data-action-id]")).toHaveLength(0);
    expect(screen.queryByText(/taste preferences/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("Undo from a second device", () => {
  it("shows no Undo for a recorded action the server can no longer undo", async () => {
    mocks.listCoachUndos.mockResolvedValue([record({ expired: true })]);
    open();
    await screen.findByText("Done");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("loads the thread's records and undoes through the server with no token", async () => {
    mocks.listCoachUndos.mockResolvedValue([record()]);
    mocks.undoCoachAction.mockResolvedValue(undefined);
    open();
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(mocks.listCoachUndos).toHaveBeenCalledWith(account, { threadId: THREAD });
    await act(async () => { fireEvent.click(undo); });
    expect(mocks.undoCoachAction).toHaveBeenCalledWith("act-1", null, expect.anything());
    await waitFor(() => expect(screen.getByText("Undone")).toBeTruthy());
  });

  it("shows a distinct line when the server finds it already undone (t23 #8)", async () => {
    mocks.listCoachUndos.mockResolvedValue([record()]);
    mocks.undoCoachAction.mockResolvedValue({ already: true });
    open();
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => { fireEvent.click(undo); });
    await waitFor(() => expect(screen.getByText("This was already undone.")).toBeTruthy());
    expect(screen.getByText("Undone")).toBeTruthy();
  });

  it("shows the server's reason when it cannot undo here", async () => {
    mocks.listCoachUndos.mockResolvedValue([record()]);
    mocks.undoCoachAction.mockRejectedValue(new Error("This can only be undone on the phone that did it."));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByText("This can only be undone on the phone that did it.")).toBeTruthy());
  });

  it("draws an issued action's record as Coach change, never from the saved action", async () => {
    mocks.listCoachUndos.mockResolvedValue([record()]);
    open();
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-action-id='act-1']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(card.querySelector("h3")?.textContent).toBe("Coach change");
    expect(card.textContent).toMatch(/\d{1,2} Oct, \d{2}:\d{2}/);
    expect(document.querySelectorAll("[data-action-id]")).toHaveLength(1);
  });

  it("draws a receipt card's title and foods, and puts an unmatched receipt after the conversation", async () => {
    const receipt = (actionId: string, messageId: string | null) => record({ id: `rec-${actionId}`, actionId,
      kind: "log_meal", card: { type: "receipt", kind: "log_meal", title: "Logged Meal 3 on Mon 5 Oct",
        lines: [{ name: "Eggs", grams: 100 }, { name: null, grams: null }], date: "2026-10-05", slot: "meal-3",
        messageId, sourceCheck: messageId ? "match" : "mismatch", complete: true } });
    mocks.listCoachUndos.mockResolvedValue([receipt("matched", MESSAGE), receipt("unmatched", null)]);
    open();
    await waitFor(() => expect(document.querySelectorAll("[data-action-id]")).toHaveLength(2));
    const matched = document.querySelector<HTMLElement>("[data-action-id='matched']")!;
    expect(matched.querySelector("h3")?.textContent).toBe("Logged Meal 3 on Mon 5 Oct");
    expect([...matched.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Eggs · 100 g", "Unnamed food"]);
    // The unmatched one sits under no message: after the saved message's own text.
    const message = screen.getByText("Logged your water.");
    const unmatched = document.querySelector<HTMLElement>("[data-action-id='unmatched']")!;
    expect(message.compareDocumentPosition(unmatched) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(matched.compareDocumentPosition(unmatched) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no Undo when the records cannot be read", async () => {
    mocks.listCoachUndos.mockRejectedValue(new Error("offline"));
    open();
    await waitFor(() => expect(mocks.listCoachUndos).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("a confirmed taste-chip record (W5b-2 Undo list)", () => {
  const tasteRecord = (over: Partial<CoachUndoView> = {}) => record({
    id: "rec-taste", actionId: "act-taste", kind: "confirm_taste_chips", createdAt: "2026-10-05T12:00:00Z",
    card: { type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
      added: { dislikes: ["f:mushroom"], cuisines: ["latin_american"] }, complete: true },
    ...over,
  });

  it("draws the chips the receipt added, never the time", async () => {
    mocks.listCoachUndos.mockResolvedValue([tasteRecord()]);
    open();
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-action-id='act-taste']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(card.querySelector("h3")?.textContent).toBe("Taste preferences added");
    expect([...card.querySelectorAll("li")].map((li) => li.textContent))
      .toEqual(["mushroom", "Mexican and Latin American"]);
  });

  it("undoes through the taste confirm/undo contract, not the generic coach undo", async () => {
    mocks.listCoachUndos.mockResolvedValue([tasteRecord()]);
    mocks.undoTasteChips.mockResolvedValue({ ok: true,
      result: { status: "undone", actionId: "act-taste", removed: { dislikes: ["f:mushroom"], cuisines: ["latin_american"] },
        gone: { dislikes: [], cuisines: [] }, undoneAt: "2026-10-05T13:00:00Z", settings: {} } });
    open();
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => { fireEvent.click(undo); });
    expect(mocks.undoTasteChips).toHaveBeenCalledWith("act-taste", { account });
    expect(mocks.undoCoachAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Undone")).toBeTruthy());
  });

  it("reflects an already-gone record honestly instead of claiming a fresh Undo", async () => {
    mocks.listCoachUndos.mockResolvedValue([tasteRecord()]);
    mocks.undoTasteChips.mockResolvedValue({ ok: true,
      result: { status: "already_undone", actionId: "act-taste", removed: { dislikes: [], cuisines: [] },
        gone: { dislikes: ["f:mushroom"], cuisines: ["latin_american"] }, undoneAt: "2026-10-05T13:00:00Z", settings: {} } });
    open();
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => { fireEvent.click(undo); });
    await waitFor(() => expect(screen.getByText("This was already undone.")).toBeTruthy());
  });

  it("tells a genuine first call that removed nothing apart from a repeat already_undone", async () => {
    // status "undone" (never run before), but every key the receipt held had already left the row
    // some other way (e.g. a direct Settings edit) — a different fact from "already undone".
    mocks.listCoachUndos.mockResolvedValue([tasteRecord()]);
    mocks.undoTasteChips.mockResolvedValue({ ok: true,
      result: { status: "undone", actionId: "act-taste", removed: { dislikes: [], cuisines: [] },
        gone: { dislikes: ["f:mushroom"], cuisines: ["latin_american"] }, undoneAt: "2026-10-05T13:00:00Z", settings: {} } });
    open();
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => { fireEvent.click(undo); });
    await waitFor(() => expect(screen.getByText(
      "Those had already changed in your settings, so Undo made no change.")).toBeTruthy());
    expect(screen.queryByText("This was already undone.")).toBeNull();
  });

  it("never reads an already_undone repeat's repeated removed keys as a fresh removal", async () => {
    mocks.listCoachUndos.mockResolvedValue([tasteRecord()]);
    mocks.undoTasteChips.mockResolvedValue({ ok: true,
      result: { status: "already_undone", actionId: "act-taste",
        removed: { dislikes: ["f:mushroom"], cuisines: ["latin_american"] }, gone: { dislikes: [], cuisines: [] },
        undoneAt: "2026-10-05T13:00:00Z", settings: {} } });
    open();
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => { fireEvent.click(undo); });
    await waitFor(() => expect(screen.getByText("This was already undone.")).toBeTruthy());
  });

  it("shows the taste route's own refusal", async () => {
    mocks.listCoachUndos.mockResolvedValue([tasteRecord()]);
    mocks.undoTasteChips.mockResolvedValue({ ok: false, reason: "refused", status: 422, code: "chip_not_proposed",
      message: "That pick is no longer offered here." });
    open();
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => { fireEvent.click(undo); });
    await waitFor(() => expect(screen.getByText("That pick is no longer offered here.")).toBeTruthy());
  });
});

describe("a composed card's tap", () => {
  it("passes the card's source and thread to apply", async () => {
    mocks.listCoachUndos.mockResolvedValue([]);
    mocks.applyCoachAction.mockReturnValue(new Promise(() => {}));
    const source = { messageId: MESSAGE, cardIndex: 1 };
    mocks.cache = { messages: [saved],
      actions: [{ action: water, status: "pending", messageId: MESSAGE, source }] };
    // A restored pending entry turns failed; Retry queues it again with its source kept.
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.applyCoachAction).toHaveBeenCalledTimes(1));
    expect(mocks.applyCoachAction.mock.calls[0][1]).toMatchObject({ source, threadId: THREAD });
  });
});
