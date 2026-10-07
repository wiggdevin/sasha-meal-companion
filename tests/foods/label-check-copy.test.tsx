// @vitest-environment jsdom

/**
 * sol finding (FIX): the Foods-sheet "I checked the label" prompt promised an outcome it cannot
 * ensure — "Mark it checked and suggestions can use it" — regardless of whether the food's
 * allergen is already `listed` (confirmed present) elsewhere, in which case marking it checked
 * changes nothing (lib/policy/allergens.ts allergenFinding reads `listed` before it ever looks at
 * `userChecked`). The copy must describe what the tap does, not promise a verdict it does not
 * control.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabelCheck } from "@/components/FoodSheet";
import type { Food } from "@/lib/foods";

vi.mock("@/lib/constraints-client", () => ({
  loadConstraints: vi.fn(async () => ({
    profile: { avoid_allergens: ["dairy"], avoid_food_ref_ids: [], banned_categories: [],
      conditions: [], notes: null },
    rev: 1,
  })),
}));
vi.mock("@/lib/foods/label-check-client", () => ({ markFoodLabelChecked: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const food: Food = {
  id: "yogurt", name: "Yogurt", role: "protein", unit: "oz",
  perUnit: { protein: 5, carbs: 4, fat: 2 }, status: "neutral",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

describe("LabelCheck prompt copy", () => {
  it("never promises that marking it checked clears the food for suggestions", async () => {
    render(<LabelCheck food={food} />);
    const prompt = await screen.findByText(/Read this product's ingredient list for dairy/);
    expect(prompt.textContent).not.toMatch(/suggestions can use it/i);
  });
});
