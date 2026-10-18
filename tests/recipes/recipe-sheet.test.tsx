// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import RecipeItemRow from "@/components/RecipeItemRow";
import RecipeSheet, { saveCopy } from "@/components/RecipeSheet";
import type { RecipeRow } from "@/lib/recipes-client";

vi.mock("@/components/Sheet", () => ({
  default: ({ title, subtitle, children, footer }: { title: string; subtitle?: string;
    children: React.ReactNode; footer?: React.ReactNode }) =>
    <div><h2>{title}</h2><p>{subtitle}</p>{children}{footer}</div>,
}));
vi.mock("@/components/CatalogSearch", () => ({ default: () => <div data-testid="catalog-search" /> }));

const client = vi.hoisted(() => ({
  save: vi.fn(async (..._args: unknown[]) => ({ recipeId: "r1", rev: 2 })),
  remove: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("@/lib/recipes-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/recipes-client")>();
  return { ...actual, saveRecipe: client.save, deleteRecipe: client.remove };
});

// Bound once: a mounted sheet seeds saved names from IndexedDB after its test ends, and a rebind
// would turn that late read into an AccountChanged rejection.
beforeAll(() => { unbindAccount(); bindAccount(TEST_USER); });
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  client.save.mockClear(); client.remove.mockClear();
  delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
});
afterEach(() => { cleanup(); });

const SAVED: RecipeRow = {
  id: "r1", name: "Rice tray", servings: 4, yield_grams: null, rev: 1,
  items: [
    { seq: 1, food_ref_id: "ref-rice", qty: 1, unit: "g", grams: 400, state: "cooked", food_revision_id: 11 },
    { seq: 2, food_ref_id: "ref-chicken", qty: 1, unit: "g", grams: 300, state: "cooked", food_revision_id: 22 },
  ],
  nutrients_per_serving: {},
};

describe("RecipeSheet copy", () => {
  it("says what an edit keeps, names no version, and says nothing for a new recipe", () => {
    expect(saveCopy({ rev: 1 })).toBe("Saving keeps your earlier logs as they were.");
    expect(saveCopy(undefined)).toBeUndefined();
  });
});

describe("RecipeItemRow", () => {
  it("shows the food, its grams and a remove target", () => {
    const markup = renderToStaticMarkup(
      <RecipeItemRow name="Jasmine rice, cooked" onGrams={() => {}} onRemove={() => {}}
        item={{ seq: 1, foodRefId: "r", qty: 1, unit: "g", grams: 180, state: "cooked" }} />);
    expect(markup).toContain("Jasmine rice, cooked");
    expect(markup).toContain("180");
    expect(markup).toContain('aria-label="Remove Jasmine rice, cooked"');
  });
});

describe("RecipeSheet editing an existing recipe", () => {
  it("seeds its items from the saved recipe so Save is not disabled", () => {
    const recipe: RecipeRow = {
      id: "r1", name: "Rice tray", servings: 4, yield_grams: null, rev: 1,
      items: [
        { seq: 1, food_ref_id: "ref-rice", qty: 1, unit: "g", grams: 400, state: "cooked", food_revision_id: 11 },
        { seq: 2, food_ref_id: "ref-chicken", qty: 1, unit: "g", grams: 300, state: "cooked", food_revision_id: 22 },
      ],
      nutrients_per_serving: {},
    };
    const markup = renderToStaticMarkup(
      <RecipeSheet recipe={recipe} onClose={() => {}} onSaved={() => {}} />);
    expect(markup).toContain("2 items");
  });
});

describe("RecipeSheet flows that must stay intact", () => {
  const picker = () => screen.queryByRole("searchbox", { name: "Search foods" });

  it("opens a new recipe on the ingredient search, with the Add ingredient row below", () => {
    render(<RecipeSheet onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByRole("heading", { name: "New recipe" })).toBeTruthy();
    expect(screen.queryByText(/version/i)).toBeNull();
    expect(picker()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add ingredient" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save recipe" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches an edit to the existing ingredient search from the Add ingredient row", () => {
    render(<RecipeSheet recipe={SAVED} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByRole("heading", { name: "Edit recipe" })).toBeTruthy();
    expect(picker()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add ingredient" }));
    expect(picker()).toBeTruthy();
    expect(screen.getByText(/^2 items/)).toBeTruthy();
  });

  it("saves an edit as the next version of the same recipe", async () => {
    const onSaved = vi.fn();
    render(<RecipeSheet recipe={SAVED} onClose={() => {}} onSaved={onSaved} />);
    expect(screen.getByText("Saving keeps your earlier logs as they were.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save recipe" })); });
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.save.mock.calls[0][0]).toMatchObject({ id: "r1", baseRev: 1, name: "Rice tray" });
    expect(onSaved).toHaveBeenCalledWith({ recipeId: "r1", rev: 2 });
  });

  it("still shows why a save failed while the ingredient search is closed", async () => {
    client.save.mockRejectedValueOnce(new Error("QuotaExceededError"));
    render(<RecipeSheet recipe={SAVED} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save recipe" })); });
    expect(picker()).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/did not save|could not save/i);
  });

  it("removes a saved recipe only after the confirmation", async () => {
    const onDeleted = vi.fn();
    render(<RecipeSheet recipe={SAVED} onClose={() => {}} onSaved={() => {}} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove recipe" }));
    expect(client.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(client.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove recipe" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm remove" })); });
    expect(client.remove).toHaveBeenCalledWith(SAVED);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
});
