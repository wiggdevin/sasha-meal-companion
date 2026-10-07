// @vitest-environment jsdom
/**
 * The Recipes card on Foods opens straight into the recipe widget (owner, 2026-10-05): no dialog, no
 * bottom sheet, and no morph out of the button (U15, owner 2026-10-04: "When I press it, the cards
 * should show up. When I exit, they should go away"). The button stays put and says it is open.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";

vi.mock("@/lib/recipes-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipes-client")>()), listRecipes: vi.fn(async () => []),
}));
vi.mock("@/lib/favorites-client", async (original) => ({
  ...(await original<typeof import("@/lib/favorites-client")>()), listFavorites: vi.fn(async () => []),
}));
vi.mock("@/components/recipes-hub/RecipeHub", async (original) => {
  const actual = await original<typeof import("@/components/recipes-hub/RecipeHub")>();
  return { ...actual, default: ({ onClose }: { onClose: () => void }) =>
    <section aria-label="New recipe"><button type="button" onClick={onClose}>Close</button></section> };
});

import RecipesSection from "@/components/RecipesSection";

beforeEach(async () => { await resetTestAccount(); });
afterEach(() => { cleanup(); });

describe("the Recipes card", () => {
  it("opens straight into the recipe widget, inside the card, with no button or dialog between", async () => {
    const { container } = render(<RecipesSection />);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "New recipe" })).toBeNull();
    const header = screen.getByRole("button", { name: /^Recipes/ });
    // Still a section heading for heading navigation.
    expect(header.closest("h2")).toBeTruthy();
    fireEvent.click(header);
    const widget = screen.getByRole("region", { name: "New recipe" });
    expect(container.querySelector("#recipes")!.contains(widget)).toBe(true);
    expect(screen.queryByRole("button", { name: "New recipe" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("folds from its header and keeps the widget mounted, and never morphs", async () => {
    const { container } = render(<RecipesSection />);
    await act(async () => {});
    const header = screen.getByRole("button", { name: /^Recipes/ });
    fireEvent.click(header);
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // Mounted after the first open, so a save in flight is not cut off by folding the card.
    expect(container.querySelector('[aria-label="New recipe"]')).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/layoutid|new-recipe-hub/i);
  });

  it("opens for a shared-recipe favorite and for a discovery link", async () => {
    render(<RecipesSection />);
    await act(async () => {});
    const header = screen.getByRole("button", { name: /^Recipes/ });
    act(() => { window.dispatchEvent(new CustomEvent("catalog-recipe-open", { detail: "r1" })); });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    act(() => { window.location.hash = "#discover-recipes"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    window.location.hash = "";
  });
});
