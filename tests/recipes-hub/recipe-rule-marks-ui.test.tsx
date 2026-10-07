// @vitest-environment jsdom
/**
 * Recipe rule marks on every recipe surface (2026-10-05, fix/ui-gap-contracts): the result card
 * (the tag closed, the line once open), the details, the hub carousel's cards, the Adjust portion
 * preview and its accepted plan, and Put it in a meal's placed plan. Blocked is red "Off your rules",
 * unknown is yellow "Check", a clear or unparsed (null) mark says nothing. A mark never hides a
 * recipe or disables a control. The preview's 422 unchecked answer is a quiet "check" notice
 * (role=status), never an error alert. Freshness after a rule change is
 * tests/recipes-hub/recipe-mark-freshness.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import type { RuleMark } from "@/lib/types";
import { RecipeRulesUncheckedError } from "@/lib/recipes/rule-mark-wire";
import type { SlotChoice } from "@/lib/recipes-hub/put-in-meal";

const search = vi.hoisted(() => vi.fn());
const plan = vi.hoisted(() => ({ preview: vi.fn(), accept: vi.fn() }));
const favorite = vi.hoisted(() => vi.fn(async () => ({ favorite: false, revision: 0 })));
vi.mock("@/lib/recipe-catalog-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-catalog-client")>()), searchCatalogRecipes: search,
  getCatalogFavorite: favorite,
}));
vi.mock("@/lib/recipe-plan-client", () => ({ previewRecipePlan: plan.preview, acceptRecipePlan: plan.accept }));

import RecipeDetails from "@/components/RecipeDetails";
import RecipeResultCard from "@/components/RecipeResultCard";
import RecipePlanFlow from "@/components/RecipePlanFlow";
import RecipeCarousel from "@/components/recipes-hub/RecipeCarousel";
import { PutInMealPicker } from "@/components/recipes-hub/PutInMeal";
import { resetFlightsForTests } from "@/components/single-flight";

const BLOCKED: RuleMark = { verdict: "blocked", reason: "Peanut sauce has peanut, which your rules exclude." };
const UNKNOWN: RuleMark = { verdict: "unknown", reason: "This recipe could not be checked against your current food rules." };

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
function recipe(name: string, ruleMark?: RuleMark | null): RecipeCandidate {
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
    source: { author: "Sasha kitchen", sourceUrl: null, rightsKind: "original", rightsRecord: "o",
      sourceRevision: "1", kitchenTested: false },
    eligibility: { status: "eligible", reasons: [] },
    ...(ruleMark === undefined ? {} : { ruleMark }),
  };
}
const marks = (root: ParentNode = document) => [...root.querySelectorAll("[data-rule-mark]")]
  .map((node) => node.getAttribute("data-rule-mark"));

beforeEach(() => {
  resetFlightsForTests();
  unbindAccount(); bindAccount("11111111-1111-4111-8111-111111111111");
  search.mockReset(); plan.preview.mockReset(); plan.accept.mockReset();
});
afterEach(cleanup);

describe("the recipe result card and details", () => {
  it("tags a blocked recipe closed and gives the line once open, with every control still there", () => {
    const view = render(<RecipeResultCard recipe={recipe("Satay", BLOCKED)} expanded={false}
      onExpandedChange={vi.fn()} actions={{ onFit: vi.fn(), onFavorite: vi.fn() }} />);
    const header = screen.getByRole("button", { expanded: false });
    expect(within(header).getByText("Off your rules").closest("[data-rule-mark]")?.getAttribute("data-rule-mark"))
      .toBe("blocked");
    expect(header.textContent).toContain(BLOCKED.reason);
    view.rerender(<RecipeResultCard recipe={recipe("Satay", BLOCKED)} expanded onExpandedChange={vi.fn()}
      actions={{ onFit: vi.fn(), onFavorite: vi.fn() }} />);
    // Open: one mark, the line in the details, and the actions are not disabled by it.
    expect(marks()).toEqual(["blocked"]);
    expect(document.querySelector("[data-recipe-details] [data-rule-mark]")?.textContent).toContain(BLOCKED.reason);
    expect(screen.getByRole("button", { name: "Adjust portion" })).toHaveProperty("disabled", false);
  });

  it("shows unknown as Check, and nothing for a clear, unparsed or never-judged recipe", () => {
    render(<RecipeResultCard recipe={recipe("Pad see ew", UNKNOWN)} expanded={false} onExpandedChange={vi.fn()} />);
    expect(screen.getByText("Check").closest("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("unknown");
    cleanup();
    for (const mark of [null, undefined]) {
      render(<RecipeResultCard recipe={recipe("Rice", mark)} expanded onExpandedChange={vi.fn()} />);
      expect(marks()).toEqual([]);
      cleanup();
    }
  });

  it("puts the line under the details' facets", () => {
    render(<RecipeDetails recipe={recipe("Satay", UNKNOWN)} />);
    const line = document.querySelector("[data-recipe-details] header [data-rule-mark]");
    expect(line?.getAttribute("data-rule-mark")).toBe("unknown");
    expect(line?.textContent).toContain("Check");
    expect(line?.textContent).toContain(UNKNOWN.reason);
  });
});

describe("the hub carousel", () => {
  it("tags each card with its own mark beside the fit", async () => {
    search.mockResolvedValue({ count: 3, limitations: [],
      recipes: [recipe("Satay", BLOCKED), recipe("Pad see ew", UNKNOWN), recipe("Rice", null)] });
    render(<RecipeCarousel remaining={{ kcal: 600, protein: 50, carbs: 80, fat: 20 }} date="2026-10-05" />);
    const carousel = await screen.findByRole("region", { name: "Recipe catalog" });
    const cards = within(carousel).getAllByRole("button", { expanded: false })
      .map((button) => button.closest("[data-recipe-card]") as HTMLElement);
    expect(cards.map((card) => marks(card))).toEqual([["blocked"], ["unknown"], []]);
    expect(cards[0].querySelector("[data-fit]")).not.toBeNull();
  });
});

describe("what a card says", () => {
  it("describes a carousel card's button by its mark, verdict and reason", async () => {
    search.mockResolvedValue({ count: 2, limitations: [], recipes: [recipe("Satay", BLOCKED), recipe("Rice", null)] });
    render(<RecipeCarousel remaining={null} date="2026-10-05" />);
    const carousel = await screen.findByRole("region", { name: "Recipe catalog" });
    const satay = within(carousel).getByRole("button", { name: /Satay/, expanded: false });
    expect(satay.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(carousel).getByRole("button", { name: /Satay/, expanded: false,
      description: `Off your rules: ${BLOCKED.reason}` })).toBe(satay);
    // Ids are the card's own.
    const rice = within(carousel).getByRole("button", { name: /Rice/, expanded: false });
    expect(rice.getAttribute("aria-describedby")).not.toBe(satay.getAttribute("aria-describedby"));
  });

  it("says a reason once when the eligibility alert already states it", () => {
    const blocked = { ...recipe("Satay", BLOCKED), eligibility: { status: "blocked" as const,
      reasons: [{ code: "policy_block", message: BLOCKED.reason, ingredientSeq: 1 }] } };
    render(<RecipeResultCard recipe={blocked} expanded onExpandedChange={vi.fn()} />);
    expect(document.body.textContent?.split(BLOCKED.reason).length).toBe(2);
    expect(screen.getByRole("alert").textContent).toContain(BLOCKED.reason);
    expect(marks()).toEqual([]);
  });

  it("keeps the mark line when the alert says something else", () => {
    const unsure = { ...recipe("Satay", UNKNOWN), eligibility: { status: "unknown" as const,
      reasons: [{ code: "incomplete_recipe", message: "A step is missing." }] } };
    render(<RecipeResultCard recipe={unsure} expanded onExpandedChange={vi.fn()} />);
    expect(document.body.textContent?.split(UNKNOWN.reason).length).toBe(2);
    expect(marks()).toEqual(["unknown"]);
  });
});

describe("Adjust portion", () => {
  const preview = (ruleMark: RuleMark | null) => ({ previewId: "p", recipe: recipe("Satay"), servingFraction: 1,
    ingredientSnapshot: [], nutritionSnapshot: { kcal: known(350), protein: known(12), carbs: known(70), fat: known(3) },
    gap: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, mealTarget: null, exactFitAvailable: true,
    approximateFitAvailable: true, evidenceIssues: [], authority: {}, ruleMark, ruleFlags: [] });

  it("shows the preview's mark and the accepted plan's mark, and still adds", async () => {
    plan.preview.mockResolvedValue(preview(BLOCKED));
    plan.accept.mockResolvedValue({ id: "s", ruleMark: UNKNOWN });
    render(<RecipePlanFlow recipe={recipe("Satay")} onClose={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview portion" })); });
    const portion = screen.getByLabelText("Portion preview");
    expect(marks(portion)).toEqual(["blocked"]);
    const add = within(portion).getByRole("button", { name: "Add to plan" });
    expect(add).toHaveProperty("disabled", false);
    await act(async () => { fireEvent.click(add); });
    expect(screen.getByText("Added to the plan.")).toBeTruthy();
    expect(marks()).toEqual(["unknown"]);
  });

  it("says nothing for a clear preview and plan", async () => {
    plan.preview.mockResolvedValue(preview(null));
    plan.accept.mockResolvedValue({ id: "s", ruleMark: null });
    render(<RecipePlanFlow recipe={recipe("Satay")} onClose={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview portion" })); });
    expect(marks()).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to plan" })); });
    expect(marks()).toEqual([]);
  });

  it("shows the 422 unchecked answer as a quiet check, not an error, with nothing to add", async () => {
    plan.preview.mockRejectedValue(new RecipeRulesUncheckedError(UNKNOWN.reason, UNKNOWN));
    render(<RecipePlanFlow recipe={recipe("Satay")} onClose={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview portion" })); });
    const notice = screen.getByRole("status", { name: "" });
    expect(notice.getAttribute("data-tone")).toBe("attention");
    expect(notice.textContent).toContain(UNKNOWN.reason);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("Portion preview")).toBeNull();
    // Preview stays available to try again.
    expect(screen.getByRole("button", { name: "Preview portion" })).toHaveProperty("disabled", false);
  });
});

describe("Put it in a meal", () => {
  const slots: SlotChoice[] = [{ slotId: "meal-3", label: "Meal 3", time: "18:00", planned: null, eaten: false }];
  const placePreview = { previewId: "p", recipe: recipe("Satay"), servingFraction: 1, exactFitAvailable: true,
    approximateFitAvailable: true };

  it("shows the placed plan's mark under its confirmation", async () => {
    plan.preview.mockResolvedValue(placePreview);
    plan.accept.mockResolvedValue({ id: "s", ruleMark: BLOCKED });
    render(<PutInMealPicker recipe={recipe("Satay")} readSlots={() => slots} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    expect(screen.getByText(/In Meal 3, today/)).toBeTruthy();
    expect(marks()).toEqual(["blocked"]);
  });

  it("places a clear plan with no mark", async () => {
    plan.preview.mockResolvedValue(placePreview);
    plan.accept.mockResolvedValue({ id: "s", ruleMark: null });
    render(<PutInMealPicker recipe={recipe("Satay")} readSlots={() => slots} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    expect(screen.getByText(/In Meal 3, today/)).toBeTruthy();
    expect(marks()).toEqual([]);
  });

  it("shows the 422 unchecked answer as a check notice, and nothing is placed", async () => {
    plan.preview.mockRejectedValue(new RecipeRulesUncheckedError(UNKNOWN.reason, UNKNOWN));
    render(<PutInMealPicker recipe={recipe("Satay")} readSlots={() => slots} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    const notice = document.querySelector(".notice[data-tone]") as HTMLElement;
    expect(notice.getAttribute("data-tone")).toBe("attention");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(UNKNOWN.reason);
    expect(plan.accept).not.toHaveBeenCalled();
  });
});
