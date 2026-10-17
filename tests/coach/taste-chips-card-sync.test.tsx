// @vitest-environment jsdom
/**
 * W103: the coach taste-chip card follows the account's pulled settings (`diet_prefs.taste`,
 * `cuisines`). Another device saving the chips, or undoing them, reaches this card on the next sync
 * pass (`SYNCED_EVENT`) with no write of its own.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ confirm: vi.fn(), undo: vi.fn() }));
vi.mock("@/lib/profile/taste-confirm-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile/taste-confirm-client")>()),
  confirmTasteChips: mocked.confirm, undoTasteChips: mocked.undo,
  newTasteActionId: () => "minted-action-id",
}));

import TasteChipsCard from "@/components/coach/TasteChipsCard";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { writeStoredTasteChips } from "@/components/coach/taste-chips-storage";
import type { TasteChipsProposal } from "@/lib/coach/taste-chips-card";
import { loadStore, resetStoreCache, saveStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import type { CuisineKey } from "@/lib/profile/cuisines";
import type { TasteDislike } from "@/lib/profile/taste";
import type { ProfileDietPrefs } from "@/lib/sync/user-settings";

const MESSAGE = "3f1b1a2c-0000-4000-8000-0000000000aa";
const card: TasteChipsProposal = {
  kind: "taste_chips_proposal", v: 1, id: "proposal-1",
  dislikes: [{ key: "t:soft", label: "Soft textures", p: 0.9 }],
  cuisines: [{ key: "latin_american", label: "Latin American", p: 0.85 }],
};

/** What a pull of another device's write leaves in this phone's settings mirror. */
function pulled(dislikes: string[], cuisines: string[]) {
  const store = loadStore();
  saveStore({ ...store, settings: { ...store.settings,
    dietPrefs: { ...(store.settings.dietPrefs ?? { flags: [] }),
      taste: { dislikes: dislikes as TasteDislike[] } } as ProfileDietPrefs,
    cuisines: cuisines as CuisineKey[] } }, { silent: true });
}
const syncPass = () => act(() => { window.dispatchEvent(new Event(SYNCED_EVENT)); });

beforeEach(() => {
  localStorage.clear();
  resetStoreCache();
  bindAccount("user-a");
  mocked.confirm.mockReset();
  mocked.undo.mockReset();
});
afterEach(() => { cleanup(); unbindAccount(); });

describe("the taste-chip card re-reads pulled settings", () => {
  it("rests as already saved when another device saved every chip", () => {
    render(<TasteChipsCard card={card} messageId={MESSAGE} />);
    expect(screen.getByRole("button", { name: "Add to my taste preferences" })).toBeTruthy();
    pulled(["t:soft"], ["latin_american"]);
    syncPass();
    expect(screen.getByText("Already in your taste preferences")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to my taste preferences" })).toBeNull();
    expect(mocked.confirm).not.toHaveBeenCalled();
  });

  it("sends only the chips another device has not saved", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: true, result: { status: "applied", actionId: "minted-action-id",
      added: { dislikes: [], cuisines: ["latin_american"] }, present: { dislikes: [], cuisines: [] },
      capped: { dislikes: [], cuisines: [] }, undoneAt: null, settings: {} } });
    render(<TasteChipsCard card={card} messageId={MESSAGE} />);
    pulled(["t:soft"], []);
    syncPass();
    const saved = screen.getByRole("button", { name: "Soft textures (saved)" }) as HTMLButtonElement;
    expect(saved.disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(mocked.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ dislikes: [], cuisines: ["latin_american"] }), expect.anything());
  });

  it("hides Undo once another device's Undo took the chips off", async () => {
    mocked.confirm.mockImplementationOnce(async () => {
      pulled(["t:soft"], ["latin_american"]); // this device's own write settles into the mirror
      window.dispatchEvent(new Event(SYNCED_EVENT));
      return { ok: true, result: { status: "applied", actionId: "minted-action-id",
        added: { dislikes: ["t:soft"], cuisines: ["latin_american"] }, present: { dislikes: [], cuisines: [] },
        capped: { dislikes: [], cuisines: [] }, undoneAt: null, settings: {} } };
    });
    render(<TasteChipsCard card={card} messageId={MESSAGE} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(await screen.findByText("Added to your taste preferences")).toBeTruthy();
    syncPass();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    pulled([], []); // the other device's Undo, pulled
    syncPass();
    expect(screen.getByText("No longer in your taste preferences")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(mocked.undo).not.toHaveBeenCalled();
  });

  it("a lost-answer retry resends the same picks under the same id, even once the mirror holds them", async () => {
    writeStoredTasteChips(bindAccount("user-a"), "proposal-1",
      { actionId: "sent-action-id", dislikes: ["t:soft"], cuisines: ["latin_american"], status: "pending" });
    mocked.confirm.mockResolvedValueOnce({ ok: true, result: { status: "existing", actionId: "sent-action-id",
      added: { dislikes: ["t:soft"], cuisines: ["latin_american"] }, present: { dislikes: [], cuisines: [] },
      capped: { dislikes: [], cuisines: [] }, undoneAt: null, settings: {} } });
    render(<TasteChipsCard card={card} messageId={MESSAGE} />);
    pulled(["t:soft"], ["latin_american"]); // the first send landed; its row was pulled
    syncPass();
    expect(screen.queryByText("Already in your taste preferences")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    expect(mocked.confirm).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "sent-action-id", dislikes: ["t:soft"], cuisines: ["latin_american"] }), expect.anything());
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("keeps Undo while the mirror never held the chips (nothing seen, nothing claimed)", async () => {
    mocked.confirm.mockResolvedValueOnce({ ok: true, result: { status: "applied", actionId: "minted-action-id",
      added: { dislikes: ["t:soft"], cuisines: [] }, present: { dislikes: [], cuisines: [] },
      capped: { dislikes: [], cuisines: [] }, undoneAt: null, settings: {} } });
    render(<TasteChipsCard card={card} messageId={MESSAGE} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to my taste preferences" })); });
    syncPass();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });
});
