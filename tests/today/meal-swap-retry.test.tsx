// @vitest-environment jsdom
/** UI audit 2026-10-18 §7: a failed swap load says so once, and offers Try again. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import type { Food } from "@/lib/foods";
import type { ResolvedSlot } from "@/lib/types";

const listRecipes = vi.hoisted(() => vi.fn(async () => []));
const allRows = vi.hoisted(() => vi.fn(async () => []));
const loadEligible = vi.hoisted(() => vi.fn(async () => new Set(["chicken", "rice", "oil"])));
vi.mock("@/lib/recipes-client", () => ({ listRecipes }));
vi.mock("@/lib/foods/eligible-client", () => ({ loadEligibleLocalFoodIds: loadEligible }));
vi.mock("@/lib/sync/idb", async (original) => ({
  ...(await original<typeof import("@/lib/sync/idb")>()), allRows,
}));

import MealSwapSheet from "@/components/MealSwapSheet";

const target = { kcal: 685, protein: 45, carbs: 70, fat: 20 };
const make = (id: string, role: Food["role"], perUnit: Food["perUnit"]): Food => ({
  id, name: id, role, perUnit, unit: "oz", status: "eats", updatedAt: "2026-09-26",
});
const foods = Object.fromEntries([
  ["chicken", make("chicken", "protein", { protein: 10, carbs: 0, fat: 1 })],
  ["rice", make("rice", "carb", { protein: 0, carbs: 10, fat: 0 })],
  ["oil", make("oil", "fat", { protein: 0, carbs: 0, fat: 5 })],
]) as Record<string, Food>;
const slot: ResolvedSlot = {
  slot: "meal-2", label: "Meal 2", time: "12:30", eaten: false,
  meal: { id: "compose:today", name: "Today meal", slot: "meal-2", components: [],
    macros: target, prepMinutes: 10, tags: [] },
  components: [], macros: target,
};

beforeEach(async () => { await resetTestAccount(); loadEligible.mockClear(); });
afterEach(cleanup);

describe("MealSwapSheet load failure", () => {
  it("shows only the error, with Try again that reloads", async () => {
    loadEligible.mockRejectedValueOnce(new Error("Couldn’t check your food rules. Try again."));
    render(<MealSwapSheet slot={slot} target={target} foods={foods} currentOverride={false}
      onSelect={async () => {}} onReset={async () => {}} onEdit={() => {}} onClose={() => {}} />);
    await screen.findByText("Couldn’t check your food rules. Try again.");
    expect(screen.queryByText(/No close matches/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(loadEligible).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Couldn’t check your food rules. Try again.")).toBeNull());
  });
});
