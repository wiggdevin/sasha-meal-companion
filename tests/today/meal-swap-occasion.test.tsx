// @vitest-environment jsdom
/** U27 (Phase 17 O1): the swap carousel ranks plates for the slot's own meal occasion and date. */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import type { Food } from "@/lib/foods";
import type { ResolvedSlot } from "@/lib/types";

const listRecipes = vi.hoisted(() => vi.fn(async () => []));
const allRows = vi.hoisted(() => vi.fn(async () => []));
const loadEligible = vi.hoisted(() => vi.fn(async () => new Set(["eggs", "oats"])));
const ranked = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], results: [] as unknown[] }));
vi.mock("@/lib/recipes-client", () => ({ listRecipes }));
vi.mock("@/lib/foods/eligible-client", () => ({ loadEligibleLocalFoodIds: loadEligible }));
vi.mock("@/lib/sync/idb", async (original) => ({
  ...(await original<typeof import("@/lib/sync/idb")>()), allRows,
}));
vi.mock("@/lib/today/swap-alternatives", async (original) => {
  const actual = await original<typeof import("@/lib/today/swap-alternatives")>();
  return { ...actual, swapAlternatives: (input: Parameters<typeof actual.swapAlternatives>[0]) => {
    ranked.calls.push(input);
    const result = actual.swapAlternatives(input);
    ranked.results.push(result);
    return result;
  } };
});

import MealSwapSheet from "@/components/MealSwapSheet";

const target = { kcal: 450, protein: 30, carbs: 45, fat: 15 };
const food = (id: string, role: Food["role"]): Food => ({ id, name: id, role, unit: "g",
  perUnit: { protein: role === "protein" ? 13 : 2, carbs: role === "carb" ? 60 : 1, fat: 5 },
  status: "eats", updatedAt: "2026-10-05" });
const foods = { eggs: food("eggs", "protein"), oats: food("oats", "carb") };
const slot: ResolvedSlot = {
  slot: "meal-1", label: "Meal 1", time: "07:30", eaten: false,
  meal: { id: "plate:x", name: "Breakfast", slot: "meal-1", components: [], macros: target,
    prepMinutes: 5, tags: [] },
  components: [], macros: target,
};

beforeEach(async () => {
  await resetTestAccount(); ranked.calls = []; ranked.results = []; loadEligible.mockClear();
});
afterEach(cleanup);

describe("MealSwapSheet occasion", () => {
  it("passes the slot's clock and the viewed date into every ranking", async () => {
    render(<MealSwapSheet slot={slot} date="2026-10-07" target={target} foods={foods}
      currentOverride={false} onSelect={async () => {}} onReset={async () => {}}
      onEdit={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(ranked.calls.length).toBe(2)); // local foods, then saved meals
    for (const call of ranked.calls) {
      expect(call).toMatchObject({ slot: "meal-1", clock: "07:30", date: "2026-10-07" });
    }
  });

  it("ranks from the verified eligible set in both calls, so a food outside it never appears", async () => {
    const withSalmon = { ...foods, salmon: food("salmon", "protein") };
    const { container } = render(<MealSwapSheet slot={slot} date="2026-10-07" target={target}
      foods={withSalmon} currentOverride={false} onSelect={async () => {}}
      onReset={async () => {}} onEdit={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(ranked.calls.length).toBe(2));
    const allowed = await loadEligible.mock.results[0].value;
    for (const call of ranked.calls) {
      expect(call.eligible).toBe(allowed);
      expect(Object.keys(call.foods as Record<string, Food>)).not.toContain("salmon");
    }
    for (const result of ranked.results as { foodIds: string[] }[][]) {
      for (const row of result) expect(row.foodIds).not.toContain("salmon");
    }
    expect(container.textContent?.toLowerCase()).not.toContain("salmon");
  });
});
