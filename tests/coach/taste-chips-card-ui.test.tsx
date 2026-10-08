// @vitest-environment jsdom
/**
 * The coach's taste-chip confirm card (Phase 18 W5b-2 UI, components/coach/TasteChipsCard.tsx):
 * nothing is written before confirm, one action id per tap reused for its retries, the honest
 * offline/retry/refused states, and Undo through the taste confirm/undo contract. Mirrors
 * tests/coach/role-confirm-ui.test.tsx's pattern for a self-contained coach card.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ confirm: vi.fn(), undo: vi.fn(), mintCount: 0 }));
vi.mock("@/lib/profile/taste-confirm-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile/taste-confirm-client")>()),
  confirmTasteChips: mocked.confirm, undoTasteChips: mocked.undo,
  newTasteActionId: () => `minted-action-id-${mocked.mintCount += 1}`,
}));

import TasteChipsCard from "@/components/coach/TasteChipsCard";
import { CoachMessageExtras } from "@/components/CoachChat";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { writeStoredTasteChips } from "@/components/coach/taste-chips-storage";
import type { TasteChipsProposal } from "@/lib/coach/taste-chips-card";

const MESSAGE = "3f1b1a2c-0000-4000-8000-0000000000aa";

const card: TasteChipsProposal = {
  kind: "taste_chips_proposal", v: 1, id: "proposal-1",
  dislikes: [{ key: "t:soft", label: "Soft textures", p: 0.9 }],
  cuisines: [{ key: "latin_american", label: "Latin American", p: 0.85 }],
};

function renderCard() {
  return render(<TasteChipsCard card={card} messageId={MESSAGE} />);
}

const settledConfirm = (added: Partial<{ dislikes: string[]; cuisines: string[] }> = {}) => ({
  ok: true as const,
  result: {
    status: "applied" as const, actionId: "minted-action-id",
    added: { dislikes: added.dislikes ?? ["t:soft"], cuisines: added.cuisines ?? ["latin_american"] },
    present: { dislikes: [], cuisines: [] }, capped: { dislikes: [], cuisines: [] },
    undoneAt: null, settings: {},
  },
});

beforeEach(() => {
  localStorage.clear();
  bindAccount("user-a");
  mocked.confirm.mockReset();
  mocked.undo.mockReset();
  mocked.mintCount = 0;
});
afterEach(() => { cleanup(); unbindAccount(); });

describe("the coach taste-chip confirm card", () => {
  it("shows the idle state: every suggested chip pre-selected, nothing written until confirm", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Soft textures" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Latin American" }).getAttribute("aria-pressed")).toBe("true");
    expect(mocked.confirm).not.toHaveBeenCalled();
  });

  it("never implies a dislike removes a food", () => {
    renderCard();
    expect(screen.getByText(/never takes a food off the table/)).toBeTruthy();
  });

  it("confirms only the chips left selected, with one action id", async () => {
    mocked.confirm.mockResolvedValueOnce(settledConfirm({ dislikes: ["t:soft"], cuisines: [] }));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Latin American" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(mocked.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "minted-action-id-1", dislikes: ["t:soft"], cuisines: [],
        coach: { messageId: MESSAGE, proposalId: "proposal-1" } }),
      expect.anything(),
    );
    expect(await screen.findByText("Added to your taste preferences")).toBeTruthy();
  });

  it("offers Undo once applied, and the resting state survives a remount", async () => {
    mocked.confirm.mockResolvedValueOnce(settledConfirm());
    const { unmount } = renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    await screen.findByText("Added to your taste preferences");
    unmount();
    renderCard();
    expect(screen.getByText("Added to your taste preferences")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("says offline honestly and keeps the picks selected", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: false, reason: "offline" });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(await screen.findByText("No connection. Tap Add again once you're back online.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Soft textures" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Add to my taste preferences" })).toBeTruthy();
  });

  it("shows a retry reason and reuses the same action id on the next tap", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: false, reason: "retry", message: "No connection. Try again." });
    mocked.confirm.mockResolvedValueOnce(settledConfirm());
    renderCard();
    const add = () => screen.getByRole("button", { name: "Add to my taste preferences" });
    await act(async () => { fireEvent.click(add()); });
    expect(await screen.findByText("No connection. Try again.")).toBeTruthy();
    await act(async () => { fireEvent.click(add()); });
    expect(mocked.confirm.mock.calls[0][0].actionId).toBe(mocked.confirm.mock.calls[1][0].actionId);
  });

  it("reuses the retry id with the SAME request order after a toggle round-trip among several chips", async () => {
    const twoDislikes: TasteChipsProposal = { ...card,
      dislikes: [{ key: "t:soft", label: "Soft textures", p: 0.9 }, { key: "f:mushroom", label: "Mushrooms", p: 0.88 }] };
    mocked.confirm.mockResolvedValueOnce({ ok: false, reason: "retry", message: "No connection. Try again." });
    mocked.confirm.mockResolvedValueOnce(settledConfirm({ dislikes: ["t:soft", "f:mushroom"], cuisines: ["latin_american"] }));
    render(<TasteChipsCard card={twoDislikes} messageId={MESSAGE} />);
    const add = () => screen.getByRole("button", { name: "Add to my taste preferences" });
    await act(async () => { fireEvent.click(add()); });
    const firstRequest = mocked.confirm.mock.calls[0][0];
    expect(firstRequest.dislikes).toEqual(["t:soft", "f:mushroom"]);
    expect(await screen.findByText("No connection. Try again.")).toBeTruthy();
    // Toggle the FIRST chip off and back on: a naive Set reorders its iteration to [mushroom, soft].
    fireEvent.click(screen.getByRole("button", { name: "Soft textures" }));
    fireEvent.click(screen.getByRole("button", { name: "Soft textures" }));
    await act(async () => { fireEvent.click(add()); });
    const secondRequest = mocked.confirm.mock.calls[1][0];
    // Same set, same id — and critically, the SAME order the proposal declared them in, so the
    // database's ordered-array comparison still reads this as the identical retried request.
    expect(secondRequest.actionId).toBe(firstRequest.actionId);
    expect(secondRequest.dislikes).toEqual(firstRequest.dislikes);
  });

  it("distinguishes a capped landing from one where every pick was already present", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: true, result: { status: "applied", actionId: "minted-action-id",
      added: { dislikes: [], cuisines: [] }, present: { dislikes: [], cuisines: [] },
      capped: { dislikes: ["t:soft"], cuisines: ["latin_american"] }, undoneAt: null, settings: {} } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(await screen.findByText("Could not add — your taste preferences are full")).toBeTruthy();
    expect(screen.queryByText("Already in your taste preferences")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("mints a fresh action id once the picks change after a refused retry", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: false, reason: "refused", status: 422,
      code: "chip_not_proposed", message: "That pick is no longer offered here." });
    mocked.confirm.mockResolvedValueOnce(settledConfirm({ dislikes: [], cuisines: ["latin_american"] }));
    renderCard();
    const add = () => screen.getByRole("button", { name: "Add to my taste preferences" });
    await act(async () => { fireEvent.click(add()); });
    expect(await screen.findByText("That pick is no longer offered here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Soft textures" })); // deselect
    await act(async () => { fireEvent.click(add()); });
    expect(mocked.confirm.mock.calls[0][0].actionId).not.toBe(mocked.confirm.mock.calls[1][0].actionId);
  });

  it("undone: undoes with the same action id, and the settings mirror comes back through the result", async () => {
    mocked.confirm.mockResolvedValueOnce(settledConfirm());
    mocked.undo.mockResolvedValueOnce({ ok: true, result: { status: "undone", actionId: "minted-action-id",
      removed: { dislikes: ["t:soft"], cuisines: ["latin_american"] }, gone: { dislikes: [], cuisines: [] },
      undoneAt: "2026-10-05T13:00:00Z", settings: { rev: 9 } } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    await screen.findByText("Added to your taste preferences");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(mocked.undo).toHaveBeenCalledWith("minted-action-id-1", expect.anything());
    expect(await screen.findByText("Removed from your taste preferences")).toBeTruthy();
  });

  it("undone: a first Undo that removed nothing (keys already gone another way) says so, not 'already undone'", async () => {
    mocked.confirm.mockResolvedValueOnce(settledConfirm());
    mocked.undo.mockResolvedValueOnce({ ok: true, result: { status: "undone", actionId: "minted-action-id",
      removed: { dislikes: [], cuisines: [] }, gone: { dislikes: ["t:soft"], cuisines: ["latin_american"] },
      undoneAt: "2026-10-05T13:00:00Z", settings: {} } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    await screen.findByText("Added to your taste preferences");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(await screen.findByText("Nothing to undo")).toBeTruthy();
    expect(screen.getByText(
      "Those had already changed in your settings, so Undo made no change.")).toBeTruthy();
    expect(screen.queryByText("Already undone")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("reflects a repeat Undo (already_undone) honestly on another device's record", async () => {
    mocked.confirm.mockResolvedValueOnce(settledConfirm());
    mocked.undo.mockResolvedValueOnce({ ok: true, result: { status: "already_undone", actionId: "minted-action-id",
      removed: { dislikes: [], cuisines: [] }, gone: { dislikes: ["t:soft"], cuisines: ["latin_american"] },
      undoneAt: "2026-10-05T13:00:00Z", settings: {} } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    await screen.findByText("Added to your taste preferences");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(await screen.findByText("This was already undone.")).toBeTruthy();
  });

  it("never reads an already_undone repeat's REPEATED removed keys as a fresh removal", async () => {
    // _taste_chips_undo_locked repeats the first call's nonempty removed arrays on a repeat tap
    // (migration 20261220090000): status alone, never `removed`'s own count, says which this is.
    mocked.confirm.mockResolvedValueOnce(settledConfirm());
    mocked.undo.mockResolvedValueOnce({ ok: true, result: { status: "already_undone", actionId: "minted-action-id",
      removed: { dislikes: ["t:soft"], cuisines: ["latin_american"] }, gone: { dislikes: [], cuisines: [] },
      undoneAt: "2026-10-05T13:00:00Z", settings: {} } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    await screen.findByText("Added to your taste preferences");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(await screen.findByText("Already undone")).toBeTruthy();
    expect(screen.getByText("This was already undone.")).toBeTruthy();
    expect(screen.queryByText("Removed from your taste preferences")).toBeNull();
  });

  it("applied: a replayed confirm that lands after the receipt was already closed shows the honest resting state", async () => {
    // A lost-answer retry's confirm can land after the SAME action id's receipt was already
    // undone (by this card, another tap, or another device) between the first send and this one.
    mocked.confirm.mockResolvedValueOnce({ ok: true, result: { status: "existing", actionId: "minted-action-id",
      added: { dislikes: ["t:soft"], cuisines: ["latin_american"] }, present: { dislikes: [], cuisines: [] },
      capped: { dislikes: [], cuisines: [] }, undoneAt: "2026-10-05T13:00:00Z", settings: {} } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(await screen.findByText("Already undone")).toBeTruthy();
    expect(screen.getByText("This was already undone.")).toBeTruthy();
    expect(screen.queryByText("Added to your taste preferences")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a replayed confirm that never added anything, closed by the time it lands, says 'nothing to undo' rather than 'already undone'", async () => {
    // Same race as above, but this tap's own `added` was always empty (every pick was already
    // `present`) -- there was nothing of THIS action's for an Undo to have removed, so claiming
    // "already undone" would overclaim (Sol r4 WARN, verified).
    mocked.confirm.mockResolvedValueOnce({ ok: true, result: { status: "existing", actionId: "minted-action-id",
      added: { dislikes: [], cuisines: [] }, present: { dislikes: ["t:soft"], cuisines: ["latin_american"] },
      capped: { dislikes: [], cuisines: [] }, undoneAt: "2026-10-05T13:00:00Z", settings: {} } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(await screen.findByText("Nothing to undo")).toBeTruthy();
    expect(screen.getByText("Nothing was added, so there was nothing to undo.")).toBeTruthy();
    expect(screen.queryByText("Already undone")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("applied: a confirm with nothing newly added never claims a fresh addition, and offers no Undo", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: true, result: { status: "existing", actionId: "minted-action-id",
      added: { dislikes: [], cuisines: [] }, present: { dislikes: ["t:soft"], cuisines: ["latin_american"] },
      capped: { dislikes: [], cuisines: [] }, undoneAt: null, settings: {} } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(await screen.findByText("Already in your taste preferences")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("names the affected chips under 'Already in your taste preferences' (followup #9)", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: true, result: { status: "existing", actionId: "minted-action-id",
      added: { dislikes: [], cuisines: [] }, present: { dislikes: ["t:soft"], cuisines: ["latin_american"] },
      capped: { dislikes: [], cuisines: [] }, undoneAt: null, settings: {} } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    await screen.findByText("Already in your taste preferences");
    expect(screen.getByText("Soft textures")).toBeTruthy();
    expect(screen.getByText("Latin American")).toBeTruthy();
  });

  it("names the affected chips under 'Some were already saved; others couldn't fit' (mixed noop)", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: true, result: { status: "applied", actionId: "minted-action-id",
      added: { dislikes: [], cuisines: [] }, present: { dislikes: ["t:soft"], cuisines: [] },
      capped: { dislikes: [], cuisines: ["latin_american"] }, undoneAt: null, settings: {} } });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(await screen.findByText("Some were already saved; others couldn't fit")).toBeTruthy();
    expect(screen.getByText("Soft textures")).toBeTruthy();
    expect(screen.getByText("Latin American")).toBeTruthy();
  });

  it("guards against a late confirm response: a conflicting confirm/Undo elsewhere wins (followup #8)", async () => {
    // This tab's confirm is slow; before it lands, storage already shows a DIFFERENT action id for
    // the same proposal (e.g. another tab finished its own tap on this same card/message first).
    let resolveFirst!: (value: unknown) => void;
    mocked.confirm.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    renderCard();
    const add = screen.getByRole("button", { name: "Add to my taste preferences" });
    fireEvent.click(add);
    await waitFor(() => expect(mocked.confirm).toHaveBeenCalledTimes(1));
    // Simulate the conflicting write landing first, from elsewhere, directly in storage.
    writeStoredTasteChips(bindAccount("user-a"), "proposal-1", {
      actionId: "someone-elses-action", dislikes: ["t:soft"], cuisines: [], status: "applied",
    });
    resolveFirst({ ok: true, result: { status: "applied", actionId: "minted-action-id-1",
      added: { dislikes: ["t:soft"], cuisines: ["latin_american"] }, present: { dislikes: [], cuisines: [] },
      capped: { dislikes: [], cuisines: [] }, undoneAt: null, settings: {} } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy());
    // The card reflects the CONFLICTING record (dislikes only), not this tab's own late response
    // (which named both a dislike and a cuisine) -- the late response was discarded, not applied.
    expect(screen.queryByRole("button", { name: "Latin American" })).toBeNull();
    expect(mocked.undo).not.toHaveBeenCalled();
  });

  it("refreshes from storage on a sync event when nothing is in flight here (followup #8)", async () => {
    mocked.confirm.mockResolvedValueOnce(settledConfirm());
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    await screen.findByText("Added to your taste preferences");
    // Another tab/device undid the same action; this tab only learns about it on the next sync pass.
    writeStoredTasteChips(bindAccount("user-a"), "proposal-1", {
      actionId: "minted-action-id-1", dislikes: [], cuisines: [], status: "undone", noop: "repeat",
    });
    await act(async () => { window.dispatchEvent(new Event("meal-companion:synced")); });
    expect(await screen.findByText("Already undone")).toBeTruthy();
  });

  it("reuses the retry id when a toggled pick returns to the attempted set", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: false, reason: "retry", message: "No connection. Try again." });
    mocked.confirm.mockResolvedValueOnce(settledConfirm());
    renderCard();
    const add = () => screen.getByRole("button", { name: "Add to my taste preferences" });
    await act(async () => { fireEvent.click(add()); }); // attempted: both chips
    expect(await screen.findByText("No connection. Try again.")).toBeTruthy();
    // Deselect, then reselect the same chip: the final picks match the original attempt again.
    fireEvent.click(screen.getByRole("button", { name: "Soft textures" }));
    fireEvent.click(screen.getByRole("button", { name: "Soft textures" }));
    await act(async () => { fireEvent.click(add()); });
    expect(mocked.confirm.mock.calls[0][0].actionId).toBe(mocked.confirm.mock.calls[1][0].actionId);
  });

  it("preserves a lost attempt's exact action id AND request across a remount", async () => {
    let resolveFirst!: (value: unknown) => void;
    mocked.confirm.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    const { unmount } = renderCard();
    // A non-default pick: deselect the cuisine chip before the first (lost) send.
    fireEvent.click(screen.getByRole("button", { name: "Latin American" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    const firstRequest = mocked.confirm.mock.calls[0][0];
    expect(firstRequest).toMatchObject({ dislikes: ["t:soft"], cuisines: [] });
    // The answer never lands (a dropped response); the conversation is reopened before it does.
    unmount();
    renderCard();
    // The reopened card must restore the SAME non-default pick, not reset to the proposal's defaults.
    expect(screen.getByRole("button", { name: "Soft textures" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Latin American" }).getAttribute("aria-pressed")).toBe("false");
    mocked.confirm.mockResolvedValueOnce(settledConfirm({ dislikes: ["t:soft"], cuisines: [] }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    const secondRequest = mocked.confirm.mock.calls[1][0];
    expect(secondRequest.actionId).toBe(firstRequest.actionId);
    expect(secondRequest).toMatchObject({ dislikes: ["t:soft"], cuisines: [] });
    resolveFirst({ ok: false, reason: "retry", message: "stale" }); // settle the abandoned first call
  });

  it("disables confirm with nothing picked", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Soft textures" }));
    fireEvent.click(screen.getByRole("button", { name: "Latin American" }));
    expect((screen.getByRole("button", { name: "Add to my taste preferences" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(mocked.confirm).not.toHaveBeenCalled();
  });
});

describe("TASTE_CHIPS_ENABLED off: a message with no tasteChips card", () => {
  it("renders exactly as an ordinary coach message, with nothing taste-related", () => {
    const { container } = render(<CoachMessageExtras
      message={{ id: "reply-1", role: "assistant", content: "Sounds good.", seq: 2,
        createdAt: "2026-09-20T12:01:00Z" }}
      messages={[]} tz="UTC" onAttachment={vi.fn()} onSearchManually={vi.fn()} onBlockStatus={vi.fn()} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText(/taste preferences/i)).toBeNull();
  });
});
