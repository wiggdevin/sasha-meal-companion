import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import FavoritesStrip, { favoriteHref, loadFavoritesForStrip } from "@/components/FavoritesStrip";
import type { FavoriteRow } from "@/lib/favorites";

vi.mock("@/lib/favorites-client", () => ({ listFavorites: vi.fn() }));

import { listFavorites } from "@/lib/favorites-client";

const rows: FavoriteRow[] = Array.from({ length: 14 }, (_, i) =>
  ({ kind: "food", id: `f${i}`, name: `Food ${i}`, sort: i }));

describe("FavoritesStrip", () => {
  it("renders nothing when she has no favorites", () => {
    expect(renderToStaticMarkup(<FavoritesStrip initial={[]} />)).toBe("");
  });

  it("pins twelve and offers All for the rest", () => {
    const markup = renderToStaticMarkup(<FavoritesStrip initial={rows} />);
    expect(markup).toContain("Food 0");
    expect(markup).not.toContain("Food 12");
    expect(markup).toContain("All");
  });

  it("sends each kind somewhere real when no onPick is given", () => {
    expect(favoriteHref({ kind: "recipe", id: "r", name: "R", sort: 1 })).toBe("/foods#recipes");
    expect(favoriteHref({ kind: "food", id: "f", name: "F", sort: 1 })).toBe("/foods");
    expect(favoriteHref({ kind: "meal", id: "m", name: "M", sort: 1 })).toBe("/");
  });
});

describe("loadFavoritesForStrip", () => {
  it("turns a rejected IndexedDB read into null instead of an unhandled rejection", async () => {
    vi.mocked(listFavorites).mockRejectedValueOnce(new Error("indexeddb blocked"));
    await expect(loadFavoritesForStrip()).resolves.toBeNull();
  });

  it("still returns her favorites on a normal read", async () => {
    vi.mocked(listFavorites).mockResolvedValueOnce(rows);
    await expect(loadFavoritesForStrip()).resolves.toEqual(rows);
  });
});
