// @vitest-environment jsdom
/**
 * The Foods page's favorites (owner, 2026-10-04): at most six chips, wrapped, never a sideways
 * scroll area; "Show all N" opens the rest in place. A star on a Foods row shows up here at once.
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FavoriteRow } from "@/lib/favorites";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/lib/favorites-client", () => ({ listFavorites: () => list() }));

const { default: FavoritesStrip } = await import("@/components/FavoritesStrip");

const rows: FavoriteRow[] = Array.from({ length: 9 }, (_, i) =>
  ({ kind: "food", id: `f${i}`, name: `Food ${i}`, sort: i }));

afterEach(cleanup);

it("wraps six chips and opens the rest in place", async () => {
  list.mockResolvedValue(rows);
  const { container } = render(<FavoritesStrip initial={rows} limit={6} />);
  expect(container.querySelector(".overflow-x-auto")).toBeNull();
  expect(screen.getAllByRole("link", { name: /^Food \d$/ })).toHaveLength(6);
  const toggle = screen.getByRole("button", { name: /^Show all 9/ });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getAllByRole("link", { name: /^Food \d$/ })).toHaveLength(9);
  await waitFor(() => expect(list).toHaveBeenCalled());
});

it("rereads when a Foods row stars something", async () => {
  list.mockResolvedValue([]);
  render(<FavoritesStrip limit={6} />);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  list.mockResolvedValue([rows[0]]);
  window.dispatchEvent(new Event("favorites-changed"));
  expect(await screen.findByRole("link", { name: "Food 0" })).toBeTruthy();
});
