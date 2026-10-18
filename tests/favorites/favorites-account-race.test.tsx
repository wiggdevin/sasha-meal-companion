// @vitest-environment jsdom
/**
 * Audit b4b #1 and #10: a favourites read is stamped with the account and a generation when it
 * starts. A read that finishes after an account switch, or after a newer read or a star that already
 * saved, is dropped — the old account's stars and chip names never paint on the next account, and a
 * stale reload never undoes a star. A star is an idempotent set, rolled back only on a real failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { FavoriteRow } from "@/lib/favorites";
import type { Food } from "@/lib/foods";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const OTHER = "22222222-2222-4222-8222-222222222222";

const favorites = vi.hoisted(() => ({ list: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/favorites-client", () => ({
  listFavorites: () => favorites.list(),
  setFavorite: (...args: unknown[]) => favorites.set(...args),
}));
vi.mock("@/lib/foods/prefs-client", () => ({
  foodRefsFor: async (food: { id: string }) => ({ userRefId: `ref-${food.id}` }),
  readPrefRefCache: () => ({ chicken: { userRefId: "ref-chicken" } }),
}));

const { default: FavoritesStrip } = await import("@/components/FavoritesStrip");
const { useFoodFavorites } = await import("@/components/MyFoods.favorites");

const row = (id: string, name: string): FavoriteRow => ({ kind: "food", id, name, sort: 1 });
const chicken = { id: "chicken", name: "Chicken" } as Food;

/** A list call the test answers by hand. */
function deferred() {
  let resolve: (rows: FavoriteRow[]) => void = () => {};
  const promise = new Promise<FavoriteRow[]>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  unbindAccount(); bindAccount(TEST_USER);
  favorites.list.mockReset().mockResolvedValue([]);
  favorites.set.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

describe("the favourites strip across an account switch", () => {
  it("clears the old account's chips at once and drops the old account's late read", async () => {
    const late = deferred();
    favorites.list.mockResolvedValueOnce([row("a", "A's oats")]);
    render(<FavoritesStrip limit={6} />);
    expect(await screen.findByText("A's oats")).toBeTruthy();

    favorites.list.mockReturnValueOnce(late.promise);
    act(() => { window.dispatchEvent(new Event("favorites-changed")); });
    act(() => { bindAccount(OTHER); });
    expect(screen.queryByText("A's oats")).toBeNull();

    await act(async () => { late.resolve([row("a", "A's oats"), row("b", "A's rice")]); });
    expect(screen.queryByText(/A's/)).toBeNull();
  });

  it("lets only the newest read land, so a slow older read never overwrites it", async () => {
    const slow = deferred();
    favorites.list.mockReturnValueOnce(slow.promise).mockResolvedValueOnce([row("n", "New star")]);
    render(<FavoritesStrip limit={6} />);
    act(() => { window.dispatchEvent(new Event("favorites-changed")); });
    expect(await screen.findByText("New star")).toBeTruthy();
    await act(async () => { slow.resolve([]); });
    expect(screen.getByText("New star")).toBeTruthy();
  });

  it("reads the new account's favourites once it is ready", async () => {
    render(<FavoritesStrip limit={6} />);
    await waitFor(() => expect(favorites.list).toHaveBeenCalledTimes(1));
    favorites.list.mockResolvedValue([row("b", "B's soup")]);
    act(() => { markAccountReady(bindAccount(OTHER)); });
    expect(await screen.findByText("B's soup")).toBeTruthy();
  });
});

describe("starring a food", () => {
  it("drops a reload that started before a star saved, so the star stays", async () => {
    const stale = deferred();
    const { result } = renderHook(() => useFoodFavorites());
    await waitFor(() => expect(favorites.list).toHaveBeenCalledTimes(1));
    favorites.list.mockReturnValueOnce(stale.promise);
    act(() => { window.dispatchEvent(new Event("favorites-changed")); });
    favorites.list.mockResolvedValue([row("ref-chicken", "Chicken")]);
    await act(async () => { await result.current.toggle(chicken); });
    expect(result.current.isStarred(chicken)).toBe(true);
    await act(async () => { stale.resolve([]); });
    expect(result.current.isStarred(chicken)).toBe(true);
  });

  it("drops the old account's read that lands after a switch", async () => {
    const late = deferred();
    favorites.list.mockReturnValueOnce(late.promise);
    const { result } = renderHook(() => useFoodFavorites());
    act(() => { bindAccount(OTHER); });
    await act(async () => { late.resolve([row("ref-chicken", "Chicken")]); });
    expect(result.current.isStarred(chicken)).toBe(false);
  });

  it("sets the asked state once, never a second toggle", async () => {
    const { result } = renderHook(() => useFoodFavorites());
    await act(async () => { await result.current.toggle(chicken); });
    expect(favorites.set).toHaveBeenCalledTimes(1);
    expect(favorites.set.mock.calls[0].slice(0, 3)).toEqual(["food", "ref-chicken", true]);
  });

  it("keeps the star, with no error, when the write landed but did not answer", async () => {
    const { result } = renderHook(() => useFoodFavorites());
    await waitFor(() => expect(favorites.list).toHaveBeenCalledTimes(1));
    favorites.set.mockRejectedValueOnce(new Error("timeout"));
    favorites.list.mockResolvedValue([row("ref-chicken", "Chicken")]);
    await act(async () => { await result.current.toggle(chicken); });
    expect(result.current.isStarred(chicken)).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("rolls back with an error when the write really failed", async () => {
    const { result } = renderHook(() => useFoodFavorites());
    await waitFor(() => expect(favorites.list).toHaveBeenCalledTimes(1));
    favorites.set.mockRejectedValueOnce(new Error("idb blocked"));
    await act(async () => { await result.current.toggle(chicken); });
    expect(result.current.isStarred(chicken)).toBe(false);
    expect(result.current.error).toBe("Could not star Chicken. Try again.");
  });
});
