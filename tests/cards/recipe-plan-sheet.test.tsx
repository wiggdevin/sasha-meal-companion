// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import PlanSheet from "@/components/PlanSheet";

const postTurn = vi.hoisted(() => vi.fn());
// Chips go to POST /api/plan/ideas; this double serves them from the same mocked coach reply.
vi.mock("@/lib/plan/ideas-client", async (original) => ({
  ...(await original<typeof import("@/lib/plan/ideas-client")>()),
  requestPlanIdeas: async (...args: [unknown, { chip: string }]) =>
    (await import("@/tests/helpers/plan-ideas")).ideasFromTurn(postTurn)(...args),
}));
const searchCatalogRecipes = vi.hoisted(() => vi.fn());
vi.mock("@/lib/recipe-access-client", () => ({ useRecipeAccess: () => ({ enabled: true, loading: false }) }));
vi.mock("@/lib/coach-client", () => ({ postTurn }));
vi.mock("@/lib/recipe-catalog-client", () => ({ searchCatalogRecipes }));
vi.mock("@/components/CatalogRecipeResults", () => ({ default: (props: {
  initialDate: string; initialSlotId: string; recipes: { name: string }[] }) =>
  <div data-testid="catalog-plan">{props.initialDate}:{props.initialSlotId}:{props.recipes.length}</div> }));
beforeEach(async () => { await resetTestAccount(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("opens a dated meal with ideas and full recipes already showing", async () => {
  postTurn.mockResolvedValue({ threadId: "t", messages: [], composed: [], suggestions: [], actions: [], draft: null });
  searchCatalogRecipes.mockResolvedValue({ recipes: [{ name: "Bowl" }], limitations: [] });
  render(<PlanSheet date="2026-10-08" slot={{ slot: "meal-3", label: "Meal 3",
    time: "18:00" } as never} target={{ kcal: 600, protein: 30, carbs: 70, fat: 18 }}
    onClose={vi.fn()} onPlaced={vi.fn()} />);
  expect((await screen.findByTestId("catalog-plan")).textContent).toBe("2026-10-08:meal-3:1");
  await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(1));
  // The opening ideas are the "Choose for me" chip for this slot and date (POST /api/plan/ideas).
  expect(postTurn.mock.calls[0][0]).toMatchObject({ chip: { chip: "choose", slot: "meal-3", date: "2026-10-08" } });
  expect(searchCatalogRecipes.mock.calls[0][0]).toMatchObject({ query: "", limit: 3 });
});
