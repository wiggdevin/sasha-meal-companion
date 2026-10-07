// @vitest-environment jsdom
/**
 * O4a: recipe search ranks and never filters (docs/plans/2026-10-05-backend-ui-handoffs.md). The
 * coach's recipe_results block carries the same `exactMatch` flag as search
 * (components/RecipeDiscovery.tsx) and shows the same "No exact match, closest recipes" line
 * above its list when the flag is false — never when it is true or absent (a block saved before
 * O4a, or a server that omits it).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

const detail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/recipe-catalog-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-catalog-client")>()), getCatalogRecipe: detail,
  getCatalogFavorite: vi.fn(async () => ({ favorite: false, revision: 0 })),
}));
vi.mock("@/lib/recipe-access-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-access-client")>()),
  useRecipeAccess: () => ({ enabled: true, loading: false }),
}));

import RecipeResultsBlock from "@/components/coach/blocks/recipe_results";
import { renderBlock } from "@/components/coach/blocks";
import { blockContext } from "@/tests/coach/blocks-client/fixtures";

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
function recipe(name: string): RecipeCandidate {
  return {
    sourceKind: "shared", recipeId: `id-${name}`, revisionId: `rev-${name}`, publicationState: "published",
    withdrawalReason: null, name, cuisine: "Home", dishTags: [], activeMinutes: 15, totalMinutes: 30,
    effort: "standard", servings: 2, yieldGrams: null, yieldStatus: "unknown", minServingFraction: 0.5,
    maxServingFraction: 2,
    ingredients: [{ seq: 1, name: "Beans", foodRefId: "f1", catalogFoodRevisionId: 1, quantity: 200, unit: "g",
      grams: 200, state: "raw", required: true, purchaseGrams: 200, purchaseConversionStatus: "known",
      nutrition: { kcal: known(700), protein: known(25), carbs: known(140), fat: known(5) }, allergenEvidence: {} }],
    steps: [{ seq: 1, text: "Simmer the beans." }],
    nutritionPerServing: { kcal: known(350), protein: known(12), carbs: known(70), fat: known(3) },
    source: { author: "Sasha kitchen", sourceUrl: null, rightsKind: "original", rightsRecord: "o",
      sourceRevision: "1", kitchenTested: false },
    eligibility: { status: "eligible", reasons: [] },
  };
}

const settle = () => act(async () => {});
const NOTICE = "No exact match, closest recipes";

beforeEach(() => {
  unbindAccount(); bindAccount("11111111-1111-4111-8111-111111111111");
  detail.mockReset();
});
afterEach(() => cleanup());

describe("the coach's recipe block says when it is showing the closest match", () => {
  it("shows the notice above the list when exactMatch is false and cards remain", async () => {
    const stored = [recipe("Satay")];
    detail.mockImplementation(async (id: string) => stored.find((row) => row.recipeId === id)!);
    render(<RecipeResultsBlock blockId="b" recipes={stored} exactMatch={false} />);
    await settle(); await settle();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Satay/ })).toBeTruthy();
  });

  it("omits the notice when exactMatch is true", async () => {
    const stored = [recipe("Satay")];
    detail.mockImplementation(async (id: string) => stored.find((row) => row.recipeId === id)!);
    render(<RecipeResultsBlock blockId="b" recipes={stored} exactMatch={true} />);
    await settle(); await settle();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("omits the notice when the block carries no exactMatch (a block saved before O4a)", async () => {
    const stored = [recipe("Satay")];
    detail.mockImplementation(async (id: string) => stored.find((row) => row.recipeId === id)!);
    render(<RecipeResultsBlock blockId="b" recipes={stored} />);
    await settle(); await settle();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("threads exactMatch from the stored block through the registry to the rendered notice", async () => {
    const stored = [recipe("Satay")];
    detail.mockImplementation(async (id: string) => stored.find((row) => row.recipeId === id)!);
    render(<>{renderBlock({ kind: "recipe_results", v: 1, id: "block-1", recipes: stored,
      limitations: [], exactMatch: false }, blockContext())}</>);
    await settle(); await settle();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });
});
