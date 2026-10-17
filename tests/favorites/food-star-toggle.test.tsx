// @vitest-environment jsdom
/** W098: the Foods star writes the one `favorites_foods` favourite, as a set, with rollback on failure. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Food } from "@/lib/foods";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const favorites = vi.hoisted(() => ({ list: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/favorites-client", () => ({
  listFavorites: () => favorites.list(),
  setFavorite: (...args: unknown[]) => favorites.set(...args),
}));
vi.mock("@/lib/foods/prefs-client", () => ({
  foodRefsFor: async (food: { id: string }) => ({ userRefId: `ref-${food.id}` }),
  readPrefRefCache: () => ({}),
}));
const { useFoodFavorites } = await import("@/components/MyFoods.favorites");
const rice = { id: "rice", name: "Rice" } as Food;

beforeEach(() => {
  unbindAccount(); markAccountReady(bindAccount(TEST_USER));
  favorites.list.mockReset().mockResolvedValue([]);
  favorites.set.mockReset().mockImplementation(async (_k, id, on) => {
    favorites.list.mockResolvedValue(on ? [{ kind: "food", id, name: "Rice", sort: 1 }] : []);
    return on;
  });
});
afterEach(cleanup);

describe("starring a food", () => {
  it("stars as a set on the food's ref, then unstars it", async () => {
    const { result } = renderHook(() => useFoodFavorites());
    await waitFor(() => expect(favorites.list).toHaveBeenCalled());
    await act(async () => { await result.current.toggle(rice); });
    expect(favorites.set).toHaveBeenLastCalledWith("food", "ref-rice", true,
      { name: "Rice", catalogFoodId: null }, expect.anything());
    expect(result.current.isStarred(rice)).toBe(true);
    await act(async () => { await result.current.toggle(rice); });
    expect(favorites.set).toHaveBeenLastCalledWith("food", "ref-rice", false, expect.anything(), expect.anything());
    expect(result.current.isStarred(rice)).toBe(false);
  });

  it("rolls back and says so when the write fails", async () => {
    favorites.set.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useFoodFavorites());
    await waitFor(() => expect(favorites.list).toHaveBeenCalled());
    await act(async () => { await result.current.toggle(rice); });
    expect(result.current.isStarred(rice)).toBe(false);
    expect(result.current.error).toBe("Could not star Rice. Try again.");
  });
});
