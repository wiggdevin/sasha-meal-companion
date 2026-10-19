// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Food } from "@/lib/foods";

const fx = vi.hoisted(() => ({
  foods: {} as Record<string, Food>,
  settings: { countryCode: "US", mealsPerDay: 3, dietPrefs: null } as Record<string, unknown>,
  ranked: false,
  accept: vi.fn(),
  rename: vi.fn(),
  addLine: vi.fn(),
  preview: vi.fn(),
}));
const account = { userId: "u1", epoch: 1 };

vi.mock("@/lib/device/account", () => ({
  AccountChanged: class AccountChanged extends Error {},
  currentAccountOrNull: () => account,
  onAccountReady: () => () => {},
  onAccountGone: () => () => {},
}));
vi.mock("@/lib/store", () => ({ loadStore: () => ({ foods: fx.foods, settings: fx.settings }) }));
vi.mock("@/lib/favorites-client", () => ({ listFavorites: async () => [{ kind: "food", id: "r9", name: "Greek yogurt", sort: 1 }] }));
vi.mock("@/lib/foods/taste-client", () => ({ loadTaste: async () => ({ status: "ok", items: [{ name: "Bananas" }] }) }));
vi.mock("@/lib/recipes-client", () => ({ listRecipes: async () => [{ id: "rec1", name: "Dal", items: [{ food_ref_id: "ref-lentils" }] }] }));
vi.mock("@/lib/sync/idb", () => ({ allRows: async () => [{ id: "m1", name: "Rice bowl", items: [{ name: "Rice" }] }] }));
vi.mock("@/lib/foods/prefs-client", () => ({ readPrefRefCache: () => ({ lentils: { userRefId: "ref-lentils" } }) }));
vi.mock("@/lib/foods/eligible-client", () => ({ loadEligibleLocalFoodIds: async () => { throw new Error("offline"); } }));
vi.mock("@/lib/shopping/build-rank-client", () => ({
  rankCandidates: async <T,>(items: T[]) => fx.ranked
    ? { items: [...items].reverse(), provenance: { ai: true, source: "jev", purpose: "shopping-build-rank" } }
    : { items, provenance: { ai: false, source: "app" } },
}));
vi.mock("@/lib/shopping-client", () => ({
  listPantry: async () => [{ name: "Oats" }],
  getShoppingPeriod: async () => ({ period: null, lines: [{ name: "Milk" }] }),
  previewShopping: (...args: unknown[]) => fx.preview(...args),
  acceptShopping: (...args: unknown[]) => fx.accept(...args),
  addManualShoppingLine: (...args: unknown[]) => fx.addLine(...args),
}));
vi.mock("@/lib/shopping/list-client", () => ({ renameShoppingPeriod: (...args: unknown[]) => fx.rename(...args) }));

import BuildListCard from "@/components/shopping/BuildListCard";

function food(id: string, name: string, status: Food["status"]): Food {
  return { id, name, role: "protein", unit: "g", perUnit: { protein: 1, carbs: 0, fat: 0 }, status,
    updatedAt: "2026-10-01T00:00:00Z" } as Food;
}
const choice = (date: string, slotId: string, recipeId: string, recipeName: string) => ({
  localDate: date, slotId, recipeId, recipeName,
  nutritionSnapshot: { kcal: { value: 520, status: "measured" }, protein: { value: 31.6, status: "measured" } } });

beforeEach(() => {
  fx.foods = { eggs: food("eggs", "Eggs", "eats"), lentils: food("lentils", "Lentils", "eats"),
    peanuts: food("peanuts", "Peanuts", "avoid"), milk: food("milk", "Milk", "eats"), tofu: food("tofu", "Tofu", "eats") };
  fx.ranked = false;
  fx.preview.mockReset().mockResolvedValue({ previewId: "p1", blockingIssues: [],
    choices: [choice("2026-10-20", "meal-1", "r1", "Shakshuka"), choice("2026-10-20", "meal-3", "r2", "Dal")] });
  fx.accept.mockReset().mockResolvedValue({ period: { id: "period-1", revision: 1 }, lines: [] });
  fx.rename.mockReset().mockResolvedValue({ id: "period-1", revision: 2 });
  fx.addLine.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

async function openFlow() {
  render(<BuildListCard periodId="period-0" />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start" })); });
}
const click = async (name: string | RegExp) => {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
};

describe("BuildListCard", () => {
  it("collapsed with Start: one olive card, its title and one line", () => {
    const { container } = render(<BuildListCard periodId={null} />);
    expect(screen.getByRole("heading", { name: "Have AI build my list" })).toBeTruthy();
    expect(screen.getByText("Pick foods and meals, yes or no.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(container.querySelector(".card-olive")).not.toBeNull();
  });

  it("opens the flow in place on the Budget step with USD for a U.S. account", async () => {
    await openFlow();
    expect(screen.getByText("Step 1 of 5 · Budget")).toBeTruthy();
    expect(screen.getByText("Budget for this list?")).toBeTruthy();
    expect(screen.getByText("Prices aren't available yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "USD" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("closes and discards everything with Close", async () => {
    await openFlow();
    await click("Skip");
    await click("Close without saving");
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    await click("Start");
    expect(screen.getByText("Step 1 of 5 · Budget")).toBeTruthy();
    expect(fx.accept).not.toHaveBeenCalled();
  });

  it("saved: walks foods and meals, saves one titled list and announces it", async () => {
    const events: string[] = [];
    const onSaved = (event: Event) => events.push(`${event.type}:${(event as CustomEvent).detail?.periodId ?? ""}`);
    window.addEventListener("shopping-list-saved", onSaved);
    window.addEventListener("recipe-plan-accepted", onSaved);
    await openFlow();
    await click("Skip");
    // Avoid, pantry and already-listed foods are never offered.
    const deck = screen.getByRole("group", { name: "Foods for your list" });
    expect(within(deck).getByText("1 of 6")).toBeTruthy();
    expect(screen.getByText("In your usual order")).toBeTruthy();
    expect(screen.queryByText("Peanuts")).toBeNull();
    expect(within(deck).getByRole("heading", { name: "Eggs" })).toBeTruthy();
    await click("Yes to Eggs");
    await click("No to Lentils");
    await click("Yes to the rest");
    expect(screen.getByText("5 of 6 foods on your list.")).toBeTruthy();
    await click("Next: meals");
    expect(fx.preview).toHaveBeenCalledTimes(1);
    expect(fx.preview.mock.calls[0][0].draft.mealCoverage).toEqual(["meal-1", "meal-2", "meal-3"]);
    expect(screen.getByText(/520 kcal · P 32 g/)).toBeTruthy();
    await click("Yes to Shakshuka");
    await click("No to Dal");
    fx.preview.mockResolvedValueOnce({ previewId: "p2", blockingIssues: [],
      choices: [choice("2026-10-20", "meal-1", "r1", "Shakshuka"), choice("2026-10-20", "meal-3", "r3", "Pasta")] });
    await click("Find other meals");
    expect(fx.preview.mock.calls[1][0].excludeRecipeIds).toEqual(["r2"]);
    await click("Yes to Pasta");
    await click("Next: stores");
    await click("Skip");
    expect(screen.getByText("5 items · 2 meals")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("List name"), { target: { value: "Sunday shop" } });
    expect(fx.accept).not.toHaveBeenCalled();
    await click("Save list");
    expect(fx.accept).toHaveBeenCalledTimes(1);
    expect(fx.accept).toHaveBeenCalledWith("p2", expect.any(String));
    expect(fx.rename).toHaveBeenCalledWith("period-1", "Sunday shop", 1, expect.any(String));
    expect(fx.addLine).toHaveBeenCalledTimes(5);
    expect(events).toEqual(["recipe-plan-accepted:", "shopping-list-saved:period-1"]);
    expect(screen.getByText("List saved. It's open below.")).toBeTruthy();
    window.removeEventListener("shopping-list-saved", onSaved);
    window.removeEventListener("recipe-plan-accepted", onSaved);
  });

  it("offers Finish saving after a failure following the accept", async () => {
    fx.addLine.mockRejectedValue(new Error("offline"));
    await openFlow();
    await click("Skip");
    await click("Yes to the rest");
    await click("Next: meals");
    await click("Yes to the rest");
    await click("Next: stores");
    await click("Skip");
    await click("Save list");
    expect(screen.getByText("Your list is saved, but a few things did not finish.")).toBeTruthy();
    fx.addLine.mockResolvedValue({});
    await click("Finish saving");
    expect(fx.accept).toHaveBeenCalledTimes(1);
    expect(screen.getByText("List saved. It's open below.")).toBeTruthy();
  });

  it("shows AI ranked only when Jev ranked the deck", async () => {
    fx.ranked = true;
    await openFlow();
    await click("Skip");
    expect(screen.getByText("AI ranked")).toBeTruthy();
    expect(screen.queryByText("In your usual order")).toBeNull();
  });

  it("goes Back a card and a step", async () => {
    await openFlow();
    await click("Skip");
    await click("Yes to Eggs");
    expect(screen.getByText("2 of 6")).toBeTruthy();
    await click("Back");
    expect(screen.getByText("1 of 6")).toBeTruthy();
    await click("Back");
    expect(screen.getByText("Step 1 of 5 · Budget")).toBeTruthy();
  });
});
