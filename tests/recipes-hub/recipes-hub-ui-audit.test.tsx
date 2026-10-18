// @vitest-environment jsdom
/**
 * UI audit 2026-10-18 §12, the recipes hub: Adjust portion offers the day's own meals and plain
 * labels, its Shopping link switches the Foods tab, the carousel can try a failed read again, and
 * the saved list and editor carry no version jargon.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import type { SlotChoice } from "@/lib/recipes-hub/put-in-meal";

const search = vi.hoisted(() => vi.fn());
const plan = vi.hoisted(() => ({ preview: vi.fn(), accept: vi.fn() }));
const slots = vi.hoisted(() => ({ read: vi.fn<(date: string) => SlotChoice[]>(() => []) }));
vi.mock("@/lib/recipe-catalog-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-catalog-client")>()), searchCatalogRecipes: search,
}));
vi.mock("@/lib/recipe-plan-client", () => ({ previewRecipePlan: plan.preview, acceptRecipePlan: plan.accept }));
vi.mock("@/components/recipes-hub/PutInMeal", async (original) => ({
  ...(await original<typeof import("@/components/recipes-hub/PutInMeal")>()),
  readMealSlots: (date: string) => slots.read(date),
}));

import RecipePlanFlow from "@/components/RecipePlanFlow";
import RecipeCarousel from "@/components/recipes-hub/RecipeCarousel";

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
function recipe(name: string): RecipeCandidate {
  return {
    sourceKind: "shared", recipeId: `id-${name}`, revisionId: `rev-${name}`, publicationState: "published",
    withdrawalReason: null, name, cuisine: "Thai", dishTags: [], activeMinutes: 20, totalMinutes: 30,
    effort: "standard", servings: 2, yieldGrams: null, yieldStatus: "unknown", minServingFraction: 0.5,
    maxServingFraction: 2,
    ingredients: [{ seq: 1, name: "Noodles", foodRefId: "f1", catalogFoodRevisionId: 1, quantity: 200, unit: "g",
      grams: 200, state: "raw", required: true, purchaseGrams: 200, purchaseConversionStatus: "known",
      nutrition: { kcal: known(700), protein: known(25), carbs: known(140), fat: known(5) }, allergenEvidence: {} }],
    steps: [{ seq: 1, text: "Boil the noodles." }],
    nutritionPerServing: { kcal: known(350), protein: known(12), carbs: known(70), fat: known(3) },
    source: { author: "Test kitchen", sourceUrl: null, rightsKind: "original", rightsRecord: "o",
      sourceRevision: "1", kitchenTested: false },
    eligibility: { status: "eligible", reasons: [] },
  };
}
const slot = (n: number, time: string, planned: string | null = null, eaten = false): SlotChoice =>
  ({ slotId: `meal-${n}`, label: `Meal ${n}`, time, planned, eaten });
const preview = () => ({ previewId: "p", recipe: recipe("Satay"), servingFraction: 1,
  ingredientSnapshot: [], nutritionSnapshot: { kcal: known(350), protein: known(12), carbs: { value: null,
    status: "unknown" as const, sourceRevisionId: null }, fat: known(3) },
  gap: { kcal: 0, protein: 0, carbs: null, fat: 0 }, mealTarget: null, exactFitAvailable: true,
  approximateFitAvailable: true, evidenceIssues: [], authority: {}, ruleMark: null, ruleFlags: [] });

beforeEach(() => {
  unbindAccount(); bindAccount("11111111-1111-4111-8111-111111111111");
  search.mockReset(); plan.preview.mockReset(); plan.accept.mockReset(); slots.read.mockReset();
  slots.read.mockReturnValue([]);
});
afterEach(cleanup);

describe("Adjust portion", () => {
  it("offers the day's own meals and starts on its first empty one", async () => {
    slots.read.mockReturnValue([slot(1, "08:00", "Oats"), slot(2, "13:00"), slot(3, "19:00")]);
    render(<RecipePlanFlow recipe={recipe("Satay")} initialDate="2026-10-18" onClose={vi.fn()} />);
    const meal = screen.getByRole("combobox", { name: "Meal" });
    expect(meal.textContent).toBe("Meal 2 · 1:00 pm");
    fireEvent.click(meal);
    expect(screen.getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Meal 1 · 8:00 am", "Meal 2 · 1:00 pm", "Meal 3 · 7:00 pm"]);
  });

  it("keeps a meal it was asked for, and falls back to six meals when the day can't be read", () => {
    render(<RecipePlanFlow recipe={recipe("Satay")} initialDate="2026-10-18" initialSlotId="meal-4" onClose={vi.fn()} />);
    const meal = screen.getByRole("combobox", { name: "Meal" });
    expect(meal.textContent).toBe("Meal 4");
    fireEvent.click(meal);
    expect(screen.getAllByRole("option")).toHaveLength(6);
  });

  it("labels the preview in plain words", async () => {
    plan.preview.mockResolvedValue(preview());
    render(<RecipePlanFlow recipe={recipe("Satay")} onClose={vi.fn()} />);
    expect(screen.getByText(/Servings \(leave blank to size it to this meal\)/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview portion" })); });
    const portion = screen.getByLabelText("Portion preview");
    expect([...portion.querySelectorAll("dt")].map((term) => term.textContent))
      .toEqual(["Calories", "Protein", "Carbs", "Fat"]);
    expect(within(portion).getByText(/Exact portion/)).toBeTruthy();
    expect(within(portion).getByText("Not known")).toBeTruthy();
    expect(portion.textContent).not.toMatch(/Revision-backed|Missing evidence/);
  });

  it("switches the Foods tab to Shopping with a hash change once a recipe is added", async () => {
    plan.preview.mockResolvedValue(preview());
    plan.accept.mockResolvedValue({ id: "s", ruleMark: null });
    window.history.replaceState(null, "", "/foods");
    const changed = vi.fn();
    window.addEventListener("hashchange", changed);
    render(<RecipePlanFlow recipe={recipe("Satay")} onClose={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview portion" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to plan" })); });
    fireEvent.click(screen.getByRole("link", { name: "Plan groceries in Shopping" }));
    expect(window.location.hash).toBe("#shopping");
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener("hashchange", changed);
    window.history.replaceState(null, "", "/");
  });
});

describe("the recipe carousel", () => {
  it("offers Try again after a failed read, and loads on the tap", async () => {
    search.mockRejectedValueOnce(new Error("offline"));
    search.mockResolvedValueOnce({ count: 1, limitations: [], recipes: [recipe("Satay")] });
    render(<RecipeCarousel remaining={null} date="2026-10-18" />);
    const again = await screen.findByRole("button", { name: "Try again" });
    await act(async () => { fireEvent.click(again); });
    expect(await screen.findByRole("region", { name: "Recipe catalog" })).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("tries again when the phone comes back online", async () => {
    search.mockRejectedValueOnce(new Error("offline"));
    search.mockResolvedValueOnce({ count: 1, limitations: [], recipes: [recipe("Satay")] });
    render(<RecipeCarousel remaining={null} date="2026-10-18" />);
    await screen.findByRole("button", { name: "Try again" });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByRole("region", { name: "Recipe catalog" })).toBeTruthy();
  });
});
