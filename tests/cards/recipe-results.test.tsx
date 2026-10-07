// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RecipeResults from "@/components/RecipeResults";
import { canFit } from "@/components/RecipeResultCard";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
function recipe(over: Partial<RecipeCandidate> = {}): RecipeCandidate {
  return {
    sourceKind: "shared", recipeId: "r1", revisionId: "v1", publicationState: "published",
    withdrawalReason: null, name: "Bean stew", cuisine: "Home", dishTags: ["stew"],
    activeMinutes: 15, totalMinutes: 40, effort: "standard", servings: 3,
    yieldGrams: 900, yieldStatus: "known", minServingFraction: 0.5, maxServingFraction: 2,
    ingredients: [{ seq: 1, name: "Beans", foodRefId: "f1", catalogFoodRevisionId: 1,
      quantity: 300, unit: "g", grams: 300, state: "raw", required: true,
      purchaseGrams: 300, purchaseConversionStatus: "known",
      nutrition: { kcal: known(900), protein: known(60), carbs: known(120), fat: known(15) },
      allergenEvidence: {} }],
    steps: [{ seq: 1, text: "Simmer the beans." }],
    nutritionPerServing: { kcal: known(300), protein: known(20), carbs: known(40), fat: known(5) },
    source: { author: "Sasha kitchen", sourceUrl: null, rightsKind: "original", rightsRecord: "original-1",
      sourceRevision: "1", kitchenTested: false },
    eligibility: { status: "eligible", reasons: [] }, ...over,
  };
}

afterEach(cleanup);
beforeEach(() => sessionStorage.clear());

describe("complete recipe results", () => {
  it("permits an approximate portion preview for the sourced pilot", () => {
    const candidate = { ...pilotRecipes()[0], eligibility: { status: "eligible" as const, reasons: [] } };
    expect(canFit(candidate)).toBe(true);
  });
  it("opens full details on a native button and keeps the expansion on remount", () => {
    const actions = { onFit: vi.fn() };
    const view = render(<RecipeResults recipes={[recipe()]} actions={actions} persistenceKey="account:block" />);
    const button = screen.getByRole("button", { name: /Bean stew/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button); // jsdom does not synthesize the browser's key activation click
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Simmer the beans.")).toBeTruthy();
    const beans = document.querySelector('[data-ingredient="Beans"]')!;
    expect(beans.textContent).toContain("Beans");
    expect(beans.textContent).toContain("300 g");
    expect(actions.onFit).not.toHaveBeenCalled();
    view.unmount();
    render(<RecipeResults recipes={[recipe()]} persistenceKey="account:block" />);
    expect(screen.getByText("Simmer the beans.")).toBeTruthy();
  });

  it("ignores incompatible saved expansion state", () => {
    sessionStorage.setItem("recipe-expanded:account:block", "{}");
    render(<RecipeResults recipes={[recipe()]} persistenceKey="account:block" />);
    const button = screen.getByRole("button", { name: /Bean stew/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("names the specific rule issue and blocks new plan actions", () => {
    render(<RecipeResults recipes={[recipe({ eligibility: { status: "unknown", reasons: [
      { code: "allergen_unknown", message: "Cannot check sesame evidence", ingredientSeq: 1 },
    ] } })]} actions={{ onFit: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: /Bean stew/ }));
    expect(screen.getByText(/Ingredient 1: Cannot check sesame evidence/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Adjust portion" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("allows an estimated portion preview without labeling its values exact", () => {
    const candidate = recipe({ nutritionPerServing: { kcal: known(300), protein: {
      value: 19, status: "estimated", sourceRevisionId: null, sourceKey: "usda-row" },
      carbs: known(40), fat: known(5) } });
    expect(canFit(candidate)).toBe(true);
    render(<RecipeResults recipes={[candidate]} actions={{ onFit: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: /Bean stew/ }));
    const protein = document.querySelector('[data-macro="protein"]')!;
    expect(protein.textContent).toContain("19");
    expect(protein.textContent).toContain("estimated");
    expect(screen.getByText(/Exact fit is unavailable/)).toBeTruthy();
  });

  it("shows unknown nutrients without a zero value or exact fit claim", () => {
    const candidate = recipe({ nutritionPerServing: { kcal: known(300), protein: {
      value: null, status: "unknown", sourceRevisionId: null }, carbs: known(40), fat: known(5) } });
    expect(canFit(candidate)).toBe(false);
    render(<RecipeResults recipes={[candidate]} actions={{ onFit: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: /Bean stew/ }));
    const protein = document.querySelector('[data-macro="protein"]')!;
    expect(protein.textContent).toContain("unknown");
    expect(protein.textContent).not.toMatch(/\b0\b/);
    expect((screen.getByRole("button", { name: "Adjust portion" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's specific no-result limitation", () => {
    render(<RecipeResults recipes={[]} limitations={["Cannot check sesame evidence for this dish."]} />);
    expect(screen.getByText("Cannot check sesame evidence for this dish.")).toBeTruthy();
  });

  it("keeps source-only prose out of the app and offers a source link", () => {
    render(<RecipeResults recipes={[recipe({ source: { author: "External", sourceUrl: "https://example.org/recipe",
      rightsKind: "link_only", rightsRecord: "link", sourceRevision: "1", kitchenTested: false } })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Bean stew/ }));
    expect(screen.queryByText("Simmer the beans.")).toBeNull();
    expect(screen.getByRole("link", { name: "View source" })).toBeTruthy();
  });
});
