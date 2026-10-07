// @vitest-environment jsdom
/**
 * Audit b4b #7: Avoid from a recipe's ingredient row writes the rule as the account that tapped,
 * and a reply that lands after an account switch changes nothing on screen and tells no listener.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const setFoodMembership = vi.hoisted(() => vi.fn());
vi.mock("@/lib/foods/prefs-client", async (original) => ({
  ...(await original<typeof import("@/lib/foods/prefs-client")>()), setFoodMembership,
}));

const { default: RecipeDetails } = await import("@/components/RecipeDetails");

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
const recipe = {
  sourceKind: "shared", recipeId: "r1", revisionId: "v1", publicationState: "published", withdrawalReason: null,
  name: "Beef lasagna", cuisine: "Italian", dishTags: [], activeMinutes: 20, totalMinutes: 35, effort: "standard",
  servings: 4, yieldGrams: null, yieldStatus: "unknown", minServingFraction: 0.5, maxServingFraction: 2,
  ingredients: [{ seq: 1, name: "Beef", foodRefId: "f1", catalogFoodRevisionId: 1, quantity: 500, unit: "g", grams: 500,
    state: "raw", required: true, purchaseGrams: 500, purchaseConversionStatus: "known",
    nutrition: { kcal: known(1000), protein: known(100), carbs: known(0), fat: known(60) }, allergenEvidence: {} }],
  steps: [{ seq: 1, text: "Bake." }],
  nutritionPerServing: { kcal: known(520), protein: known(38), carbs: known(40), fat: known(20) },
  source: { author: "Sasha kitchen", sourceUrl: "https://example.org/r", rightsKind: "original", rightsRecord: "o",
    sourceRevision: "1", kitchenTested: false },
  eligibility: { status: "eligible", reasons: [] },
} as unknown as RecipeCandidate;

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); setFoodMembership.mockReset(); });
afterEach(cleanup);

async function tapAvoid() {
  fireEvent.click(screen.getByRole("button", { name: "More for Beef" }));
  fireEvent.click(await screen.findByRole("button", { name: "Avoid Beef" }));
}

it("writes the rule as the account that tapped", async () => {
  setFoodMembership.mockResolvedValue(null);
  const changed = vi.fn();
  window.addEventListener("recipe-avoid-changed", changed);
  render(<RecipeDetails recipe={recipe} />);
  await act(async () => { await tapAvoid(); });
  expect(setFoodMembership.mock.calls[0][2]).toMatchObject({ acknowledge: true,
    account: expect.objectContaining({ userId: TEST_USER }) });
  expect(screen.getByRole("status").textContent).toContain("Beef added to your Avoid rules.");
  expect(changed).toHaveBeenCalledTimes(1);
  window.removeEventListener("recipe-avoid-changed", changed);
});

it.each([["succeeds", true], ["fails", false]])("says nothing and tells no one when it %s after a switch", async (_, ok) => {
  let settle: () => void = () => {};
  setFoodMembership.mockReturnValue(new Promise<null>((resolve, reject) => {
    settle = () => ok ? resolve(null) : reject(new Error("account changed"));
  }));
  const changed = vi.fn();
  window.addEventListener("recipe-avoid-changed", changed);
  render(<RecipeDetails recipe={recipe} />);
  await tapAvoid();
  act(() => { bindAccount("22222222-2222-4222-8222-222222222222"); });
  await act(async () => { settle(); });
  expect(screen.queryByRole("status")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  // The row is usable again for the account now bound.
  expect((screen.getByRole("button", { name: "Avoid Beef" }) as HTMLButtonElement).disabled).toBe(false);
  window.removeEventListener("recipe-avoid-changed", changed);
});
