// @vitest-environment jsdom
/**
 * FluidVoice A03/A06/U02/X01: search is the first Recipes control, the three filters share one row,
 * and an empty or conflicting filter result says so plainly with a Reset filters action. Since the
 * 2026-10-04 input tiers the field is the shared lookup field (SearchField: a magnifier and a clear,
 * no send button); Enter, or the keyboard's Search key, runs the one search path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

type SearchResult = { recipes: unknown[]; count: number; limitations: string[]; exactMatch?: boolean };
const catalog = vi.hoisted(() => ({
  search: vi.fn(async (..._args: unknown[]): Promise<SearchResult> =>
    ({ recipes: [], count: 0, limitations: [] })),
}));
vi.mock("@/lib/recipe-catalog-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/recipe-catalog-client")>();
  return { ...actual, searchCatalogRecipes: catalog.search, getCatalogRecipe: vi.fn() };
});
vi.mock("@/components/CatalogRecipeResults", () => ({
  default: ({ recipes }: { recipes: { name: string }[] }) =>
    <ul aria-label="Recipe results">{recipes.map((recipe) => <li key={recipe.name}>{recipe.name}</li>)}</ul>,
}));

const { default: RecipeDiscovery } = await import("./RecipeDiscovery");
const { RecipeSearchError } = await import("@/lib/recipe-catalog-client");

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); catalog.search.mockClear(); });
afterEach(() => { cleanup(); });

const field = () => screen.getByRole("searchbox", { name: "Recipe dish or ingredient" }) as HTMLInputElement;
/** The filters live in the shared Disclosure, closed until asked for. */
const openFilters = () => fireEvent.click(screen.getByRole("button", { name: "Recipe filters" }));

async function settle() { await act(async () => {}); }

describe("recipe search layout", () => {
  it("puts the search field first, as the shared lookup field with no send button", () => {
    const { container } = render(<RecipeDiscovery />);
    const section = container.querySelector("#discover-recipes")!;
    const focusable = section.querySelectorAll("input, button, select, textarea, summary, a[href]");
    expect(focusable[0]).toBe(field());
    expect(field().closest("[data-tier='lookup']")).toBeTruthy();
    expect(field().getAttribute("enterkeyhint")).toBe("search");
    expect(screen.queryByRole("button", { name: "Search recipes" })).toBeNull();
  });

  it("runs the search on Enter, with the field's words", async () => {
    render(<RecipeDiscovery />);
    fireEvent.change(field(), { target: { value: "stew" } });
    fireEvent.submit(field().form!);
    await settle();
    expect(catalog.search).toHaveBeenCalledTimes(1);
    expect(catalog.search.mock.calls[0][0]).toMatchObject({ query: "stew" });
  });

  it("keeps cuisine, max minutes and effort on one row", () => {
    render(<RecipeDiscovery />);
    openFilters();
    const cuisine = screen.getByRole("textbox", { name: "Cuisine" });
    const minutes = screen.getByRole("spinbutton", { name: "Max minutes" });
    const effort = screen.getByLabelText("Cooking effort");
    const row = cuisine.closest("[data-filter-row]");
    expect(row).toBeTruthy();
    expect(row?.className).toContain("grid-cols-3");
    expect(row?.contains(minutes)).toBe(true);
    expect(row?.contains(effort)).toBe(true);
  });
});

describe("exact-match banner (O4a: ranking never filters)", () => {
  it("shows 'No exact match, closest recipes' above the list when the search found none", async () => {
    catalog.search.mockResolvedValueOnce({ recipes: [{ name: "Bean stew" }], count: 1, limitations: [],
      exactMatch: false });
    render(<RecipeDiscovery />);
    fireEvent.change(field(), { target: { value: "pork" } });
    fireEvent.submit(field().form!);
    await settle();
    expect(screen.getByText("No exact match, closest recipes")).toBeTruthy();
    expect(screen.getByText("Bean stew")).toBeTruthy();
  });

  it("shows no banner when the search found an exact match", async () => {
    catalog.search.mockResolvedValueOnce({ recipes: [{ name: "Bean stew" }], count: 1, limitations: [],
      exactMatch: true });
    render(<RecipeDiscovery />);
    fireEvent.change(field(), { target: { value: "bean stew" } });
    fireEvent.submit(field().form!);
    await settle();
    expect(screen.queryByText("No exact match, closest recipes")).toBeNull();
    expect(screen.getByText("Bean stew")).toBeTruthy();
  });

  it("shows no banner when the server leaves exactMatch out", async () => {
    catalog.search.mockResolvedValueOnce({ recipes: [{ name: "Bean stew" }], count: 1, limitations: [] });
    render(<RecipeDiscovery />);
    fireEvent.change(field(), { target: { value: "bean stew" } });
    fireEvent.submit(field().form!);
    await settle();
    expect(screen.queryByText("No exact match, closest recipes")).toBeNull();
  });
});

describe("empty and conflicting filter results", () => {
  it("says a cuisine has no recipe and resets the filters on request", async () => {
    render(<RecipeDiscovery />);
    openFilters();
    fireEvent.change(screen.getByRole("textbox", { name: "Cuisine" }), { target: { value: "Chinese" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Max minutes" }), { target: { value: "20" } });
    fireEvent.submit(field().form!);
    await settle();
    expect(catalog.search.mock.calls[0][0]).toMatchObject({ cuisine: "Chinese", maxMinutes: 20 });
    expect(screen.getByRole("status").textContent).toMatch(/No recipes match these filters/);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await settle();
    expect((screen.getByRole("textbox", { name: "Cuisine" }) as HTMLInputElement).value).toBe("");
    expect(catalog.search).toHaveBeenCalledTimes(2);
    expect(catalog.search.mock.calls[1][0]).toEqual({ query: "", limit: 3 });
  });

  it("offers Reset filters when the typed dish names a different cuisine", async () => {
    catalog.search.mockRejectedValueOnce(new RecipeSearchError("conflicting_filters",
      "The cuisine in your search differs from the selected cuisine."));
    render(<RecipeDiscovery />);
    fireEvent.change(field(), { target: { value: "italian pasta" } });
    openFilters();
    fireEvent.change(screen.getByRole("textbox", { name: "Cuisine" }), { target: { value: "Thai" } });
    fireEvent.submit(field().form!);
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/differs from the selected cuisine/);
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await settle();
    expect(catalog.search.mock.calls[1][0]).toEqual({ query: "italian pasta", limit: 3 });
  });

  it("shows no reset for an empty search with no filters set", async () => {
    render(<RecipeDiscovery />);
    fireEvent.change(field(), { target: { value: "zxqnotfood" } });
    fireEvent.submit(field().form!);
    await settle();
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
  });
});
