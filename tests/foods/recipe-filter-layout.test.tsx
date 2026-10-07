// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/device/account", () => ({
  currentAccountOrNull: () => null,
  onAccountReady: () => () => {},
  onAccountGone: () => () => {},
}));

vi.mock("@/lib/recipe-catalog-client", () => ({
  getCatalogRecipe: vi.fn(),
  searchCatalogRecipes: vi.fn(),
  RecipeSearchError: class RecipeSearchError extends Error {},
}));

vi.mock("@/components/CatalogRecipeResults", () => ({ default: () => null }));

import RecipeDiscovery from "@/components/RecipeDiscovery";

afterEach(cleanup);

it("keeps Cuisine, Max minutes, and Cooking effort in one compact three-column row", () => {
  render(<RecipeDiscovery />);
  fireEvent.click(screen.getByRole("button", { name: "Recipe filters" }));

  const cuisine = screen.getByLabelText("Cuisine");
  const minutes = screen.getByLabelText("Max minutes");
  const effort = screen.getByRole("combobox", { name: "Cooking effort" });
  const row = cuisine.closest("div.grid");

  expect(row).not.toBeNull();
  expect(minutes.closest("div.grid")).toBe(row);
  expect(effort.closest("div.grid")).toBe(row);
  expect(row?.classList.contains("grid-cols-3")).toBe(true);
  expect(cuisine.closest("label")?.classList.contains("col-span-2")).toBe(false);
});
