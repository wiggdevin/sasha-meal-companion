// @vitest-environment jsdom
/**
 * FluidVoice A07/U04: the ingredient editor ends with a row-shaped blank affordance — minus and
 * plus edges, muted "Add ingredient" copy — that opens the existing ingredient search and leaves
 * the draft untouched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RecipeDraftList from "./RecipeDraftList";
import type { RecipeDraft } from "@/lib/recipes/recipe-sheet-state";
import type { RecipeStrip } from "@/lib/recipes/use-recipe-sheet";

afterEach(() => { cleanup(); });

const RICE: RecipeDraft = { seq: 1, foodRefId: "ref-rice", name: "Jasmine rice, cooked", qty: 1,
  unit: "g", grams: 180, state: "cooked", foodRevisionId: 11 };

function list(items: RecipeDraft[], strip: RecipeStrip | null = null) {
  const props = { onGrams: vi.fn<(index: number, grams: number) => void>(),
    onRemove: vi.fn<(index: number) => void>(), onAddIngredient: vi.fn<() => void>() };
  render(<RecipeDraftList items={items} totalGrams={180} servings={2} yieldGrams={null}
    strip={strip} stripError={null} {...props} />);
  return props;
}

/** #21: the strip is `{ kcal, coverage, nutritionComplete }`; partial says "at least". */
describe("the per-serving strip", () => {
  const stripText = () => document.querySelector("[data-serving-strip]")?.textContent ?? "";

  it("states a complete serving's kcal plainly", () => {
    list([RICE], { kcal: 210, coverage: 1, nutritionComplete: true });
    // Read as spoken: "210 calories", then the visible tail.
    expect(stripText()).toContain("210 calories");
    expect(stripText()).toContain("kcal a serving · 90 g");
    expect(stripText()).not.toContain("at least");
  });

  it("says a partly measured serving is at least its kcal, with no unmeasured suffix", () => {
    list([RICE], { kcal: 210, coverage: 0.5, nutritionComplete: false });
    expect(stripText().startsWith("at least210 calories")).toBe(true);
    expect(stripText()).toContain("kcal a serving · 90 g");
    expect(stripText()).not.toContain("unmeasured");
  });

  it("shows no kcal number when it is unknown", () => {
    list([RICE], { kcal: null, coverage: 0, nutritionComplete: false });
    expect(stripText()).toBe("90 g a serving");
    expect(stripText()).not.toMatch(/kcal|—/);
  });
});

describe("the Add ingredient row", () => {
  it("ends the ingredient rows with a muted, row-shaped Add ingredient control", () => {
    list([RICE]);
    const add = screen.getByRole("button", { name: "Add ingredient" });
    const rows = add.closest("[data-ingredient-rows]");
    expect(rows).toBeTruthy();
    expect(rows?.lastElementChild?.contains(add)).toBe(true);
    expect(rows?.firstElementChild?.textContent).toContain("Jasmine rice, cooked");
    expect(add.textContent).toContain("Add ingredient");
    const edges = add.querySelectorAll("[data-edge]");
    expect([...edges].map((node) => node.getAttribute("data-edge"))).toEqual(["minus", "plus"]);
    expect([...edges].every((node) => node.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(add.className).toContain("min-h-11");
  });

  it("opens the picker without changing the draft", () => {
    const props = list([RICE]);
    fireEvent.click(screen.getByRole("button", { name: "Add ingredient" }));
    expect(props.onAddIngredient).toHaveBeenCalledTimes(1);
    expect(props.onGrams).not.toHaveBeenCalled();
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("1 items · 180 g")).toBeTruthy();
  });

  it("is there for an empty recipe too", () => {
    list([]);
    expect(screen.getByRole("button", { name: "Add ingredient" })).toBeTruthy();
  });
});
