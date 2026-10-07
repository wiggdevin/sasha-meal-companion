// @vitest-environment jsdom
/**
 * U5 (owner, 2026-10-04: "the card state should not change. The only thing that should change is the
 * check mark and the cross-out"): an ingredient's hidden checkbox is placed inside its own row, so
 * focusing it never scrolls a far-off box, and the ticks are kept per recipe revision for the session,
 * so a card that re-renders or remounts keeps its checklist.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import RecipeDetails from "@/components/RecipeDetails";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
const ingredient = (seq: number, name: string) => ({ seq, name, foodRefId: `f${seq}`, catalogFoodRevisionId: seq,
  quantity: 100, unit: "g", grams: 100, state: "raw", required: true, purchaseGrams: 100,
  purchaseConversionStatus: "known", allergenEvidence: {},
  nutrition: { kcal: known(100), protein: known(10), carbs: known(5), fat: known(3) } });
const recipe = (revisionId: string) => ({
  sourceKind: "shared", recipeId: "r1", revisionId, publicationState: "published", withdrawalReason: null,
  name: "Chicken skillet", cuisine: "American", dishTags: [], activeMinutes: 20, totalMinutes: 25, effort: "standard",
  servings: 3, yieldGrams: null, yieldStatus: "unknown", minServingFraction: 0.5, maxServingFraction: 2,
  ingredients: ["Carrots", "Olive oil", "Chicken", "Quinoa", "Water"].map((name, index) => ingredient(index + 1, name)),
  steps: [{ seq: 1, text: "Cook." }],
  nutritionPerServing: { kcal: known(508), protein: known(51), carbs: known(44), fat: known(13) },
  source: { author: "Sasha kitchen", sourceUrl: null, rightsKind: "original", rightsRecord: "o",
    sourceRevision: "1", kitchenTested: true },
  eligibility: { status: "eligible", reasons: [] },
}) as unknown as RecipeCandidate;

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

const boxes = () => within(screen.getByRole("region", { name: "Ingredients" })).getAllByRole("checkbox") as HTMLInputElement[];

it("ticks five rows and changes only their ticks, each hidden box placed inside its own row", () => {
  render(<RecipeDetails recipe={recipe("v1")} />);
  const rowsBefore = Array.from(document.querySelectorAll("[data-ingredient]"), (row) => row.outerHTML.length);
  for (const box of boxes()) {
    // The sr-only box's containing block is its own label, never an ancestor outside the row.
    expect(box.closest("label")?.className).toMatch(/\brelative\b/);
    fireEvent.click(box);
  }
  expect(boxes().map((box) => box.checked)).toEqual([true, true, true, true, true]);
  // Nothing else in the rows changed: only the checked state (the tick and strike-through are CSS).
  expect(Array.from(document.querySelectorAll("[data-ingredient]"), (row) => row.outerHTML.length)).toEqual(rowsBefore);
});

it("keeps the ticks for the session, per recipe revision", () => {
  const first = render(<RecipeDetails recipe={recipe("v1")} />);
  fireEvent.click(boxes()[0]);
  fireEvent.click(boxes()[3]);
  first.unmount();
  render(<RecipeDetails recipe={recipe("v1")} />);
  expect(boxes().map((box) => box.checked)).toEqual([true, false, false, true, false]);
  cleanup();
  render(<RecipeDetails recipe={recipe("v2")} />);
  expect(boxes().every((box) => !box.checked)).toBe(true);
});
