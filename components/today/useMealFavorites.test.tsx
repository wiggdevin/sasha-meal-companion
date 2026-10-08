// @vitest-environment jsdom
/**
 * The meal card heart on Today (meal cards v3): one saved meal per plate, read back after every
 * sync, saved with the day's verified set, removed by id, and undone exactly.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSlot } from "@/lib/types";

const api = vi.hoisted(() => ({
  favoriteMealFor: vi.fn(),
  saveFavoriteMeal: vi.fn(),
  removeFavoriteMeal: vi.fn(),
  undoSaveFavoriteMeal: vi.fn(),
}));
vi.mock("@/lib/favorite-meals-client", () => api);
vi.mock("@/lib/device/account", () => ({
  currentAccountOrNull: () => ({ userId: "u1", epoch: 1 }),
  AccountChanged: class AccountChanged extends Error {},
}));

import { useMealFavorites } from "./useMealFavorites";
import { AccountChanged } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/sync/client";

afterEach(cleanup);
beforeEach(() => { for (const fn of Object.values(api)) fn.mockReset(); });

const DATE = "2026-10-08";
const zero = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
const planned: ResolvedSlot = {
  slot: "meal-2", time: "12:30", label: "Meal 2", eaten: false, macros: zero,
  meal: { id: "suggested:abc", name: "Chicken and rice", slot: "meal-2", components: [], macros: zero, prepMinutes: 0, tags: [] },
  components: [{ name: "Chicken breast", qty: 5, unit: "oz", role: "protein", macros: zero }],
};
const empty: ResolvedSlot = { ...planned, slot: "meal-3", label: "Meal 3", meal: null, components: [] };

function feedback() {
  return {
    run: vi.fn(async (operation: () => Promise<unknown>) => {
      try { return { ok: true as const, value: await operation() }; } catch (error) { return { ok: false as const, error }; }
    }),
    notify: vi.fn(),
    phaseFor: vi.fn(() => undefined),
  };
}

function setup(eligible: Set<string> | null = new Set(["f1"])) {
  const fb = feedback();
  // As on Today: every render, each card asks for its own heart.
  const hook = renderHook(() => {
    const favorites = useMealFavorites({ eligible, feedback: fb });
    favorites.favoriteFor(planned, DATE);
    favorites.favoriteFor(empty, DATE);
    return { favoriteFor: (slot: ResolvedSlot) => favorites.favoriteFor(slot, DATE) };
  });
  return { fb, ...hook };
}

describe("useMealFavorites", () => {
  it("reads each planned plate's saved meal and offers no heart on an empty slot", async () => {
    api.favoriteMealFor.mockResolvedValue("saved-1");
    const { result } = setup();
    await waitFor(() => expect(result.current.favoriteFor(planned)?.on).toBe(true));
    expect(api.favoriteMealFor).toHaveBeenCalledWith({ date: "2026-10-08", slotId: "meal-2", mealId: "suggested:abc" });
    expect(result.current.favoriteFor(empty)).toBeUndefined();
  });

  it("saves the plate with the day's verified set and offers an exact Undo", async () => {
    api.favoriteMealFor.mockResolvedValue(null);
    api.saveFavoriteMeal.mockResolvedValue({ ok: true, id: "saved-9", newlyFavored: ["chicken breast"], skipped: [] });
    api.undoSaveFavoriteMeal.mockResolvedValue({ ok: true, id: "saved-9", cleared: ["chicken breast"], kept: [] });
    const eligible = new Set(["f1"]);
    const { result, fb } = setup(eligible);
    await waitFor(() => expect(result.current.favoriteFor(planned)?.on).toBe(false));
    await act(async () => { result.current.favoriteFor(planned)?.onToggle(); });
    expect(api.saveFavoriteMeal).toHaveBeenCalledWith(
      { name: "Chicken and rice", components: planned.components, source: { date: "2026-10-08", slotId: "meal-2", mealId: "suggested:abc" } },
      { eligible });
    await waitFor(() => expect(result.current.favoriteFor(planned)?.on).toBe(true));
    const notice = fb.notify.mock.calls.at(-1)?.[0];
    expect(notice.message).toBe("Chicken and rice saved to favorite meals.");
    await act(async () => { notice.action.action(); });
    expect(api.undoSaveFavoriteMeal).toHaveBeenCalledWith("saved-9", ["chicken breast"]);
    await waitFor(() => expect(result.current.favoriteFor(planned)?.on).toBe(false));
  });

  it("names the foods a rule kept out of Favorites", async () => {
    api.favoriteMealFor.mockResolvedValue(null);
    api.saveFavoriteMeal.mockResolvedValue({ ok: true, id: "saved-9", newlyFavored: [], skipped: ["almond butter"] });
    const { result, fb } = setup();
    await waitFor(() => expect(result.current.favoriteFor(planned)).toBeDefined());
    await act(async () => { result.current.favoriteFor(planned)?.onToggle(); });
    expect(fb.notify.mock.calls.at(-1)?.[0].message)
      .toBe("Chicken and rice saved to favorite meals. Not favored under your food rules: almond butter.");
  });

  it("removes by id only, and its Undo saves the plate again", async () => {
    api.favoriteMealFor.mockResolvedValue("saved-1");
    api.removeFavoriteMeal.mockResolvedValue({ ok: true, id: "saved-1" });
    api.saveFavoriteMeal.mockResolvedValue({ ok: true, id: "saved-2", newlyFavored: [], skipped: [] });
    const { result, fb } = setup();
    await waitFor(() => expect(result.current.favoriteFor(planned)?.on).toBe(true));
    await act(async () => { result.current.favoriteFor(planned)?.onToggle(); });
    expect(api.removeFavoriteMeal).toHaveBeenCalledWith("saved-1");
    await waitFor(() => expect(result.current.favoriteFor(planned)?.on).toBe(false));
    const notice = fb.notify.mock.calls.at(-1)?.[0];
    expect(notice.message).toBe("Chicken and rice removed from favorite meals. Its foods stay Favored.");
    await act(async () => { notice.action.action(); });
    expect(api.saveFavoriteMeal).toHaveBeenCalledTimes(1);
  });

  it("shows a failed write as an error and keeps the heart as it was", async () => {
    api.favoriteMealFor.mockResolvedValue(null);
    api.saveFavoriteMeal.mockResolvedValue({ ok: false, reason: "offline", message: "Saving a meal needs a connection." });
    const { result, fb } = setup();
    await waitFor(() => expect(result.current.favoriteFor(planned)).toBeDefined());
    await act(async () => { result.current.favoriteFor(planned)?.onToggle(); });
    expect(fb.notify).toHaveBeenCalledWith({ tone: "error", message: "Saving a meal needs a connection." });
    expect(result.current.favoriteFor(planned)?.on).toBe(false);
  });

  it("re-reads after a sync", async () => {
    api.favoriteMealFor.mockResolvedValueOnce(null).mockResolvedValue("saved-3");
    const { result } = setup();
    await waitFor(() => expect(result.current.favoriteFor(planned)?.on).toBe(false));
    await act(async () => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
    await waitFor(() => expect(result.current.favoriteFor(planned)?.on).toBe(true));
  });

  it("settles quietly, with no unhandled rejection, when the account changes mid-write", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      api.favoriteMealFor.mockResolvedValue(null);
      api.saveFavoriteMeal.mockRejectedValue(new AccountChanged());
      const { result, fb } = setup();
      await waitFor(() => expect(result.current.favoriteFor(planned)).toBeDefined());
      await act(async () => { result.current.favoriteFor(planned)?.onToggle(); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(fb.notify).not.toHaveBeenCalled();
      expect(result.current.favoriteFor(planned)?.pending).toBe(false);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("settles quietly, with no unhandled rejection, when Undo's own write hits an account change",
    async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        api.favoriteMealFor.mockResolvedValue(null);
        api.saveFavoriteMeal.mockResolvedValue({ ok: true, id: "saved-9", newlyFavored: [], skipped: [] });
        api.undoSaveFavoriteMeal.mockRejectedValue(new AccountChanged());
        const { result, fb } = setup();
        await waitFor(() => expect(result.current.favoriteFor(planned)).toBeDefined());
        await act(async () => { result.current.favoriteFor(planned)?.onToggle(); });
        const notice = fb.notify.mock.calls.at(-1)?.[0];
        await act(async () => { notice.action.action(); });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
});
