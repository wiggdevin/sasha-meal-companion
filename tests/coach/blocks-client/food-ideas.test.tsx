// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FoodIdeasBlock from "@/components/coach/blocks/food_ideas";
import type { FoodIdeasBlockV1 } from "@/lib/coach/ui-blocks";
import { blockContext } from "@/tests/coach/blocks-client/fixtures";

afterEach(cleanup);

function idea(name: string, ref: string): FoodIdeasBlockV1["ideas"][number] {
  return {
    wish: name, slot: "meal-2", items: [{
      name, foodRefId: ref, catalogFoodRevisionId: 71, grams: 180,
      kcalPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3,
      macros: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 }, verdict: "allowed",
    }],
    totals: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 },
    target: { kcal: 400, protein: 30, carbs: 50, fat: 10 },
    flagged: [], fitsTarget: true,
  };
}

const twoIdeas: FoodIdeasBlockV1 = { kind: "food_ideas", v: 1, id: "ideas-1", ideas: [
  idea("Rice bowl", "11111111-1111-4111-8111-111111111111"),
  idea("Chicken plate", "22222222-2222-4222-8222-222222222222"),
] };

describe("food ideas block", () => {
  it("renders one existing suggestion card per idea with all three actions", () => {
    const applyAction = vi.fn();
    render(<FoodIdeasBlock block={twoIdeas} ctx={blockContext({ applyAction })} />);

    expect(screen.getAllByRole("button", { name: "Log it" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Put it in Meal 2" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Save as recipe" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Log it" })[0]);
    expect(applyAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "log_meal" }));
  });

  it("hands a tap to the ledger once and removes the tapped idea like a composed card", () => {
    const applyAction = vi.fn();
    render(<FoodIdeasBlock block={twoIdeas} ctx={blockContext({ applyAction })} />);

    const logButton = screen.getAllByRole("button", { name: "Log it" })[0];
    fireEvent.click(logButton);
    fireEvent.click(logButton);

    expect(applyAction).toHaveBeenCalledOnce();
    expect(screen.queryByText("Rice bowl")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Log it" })).toHaveLength(1);
    expect(screen.getByText("Chicken plate")).toBeTruthy();
  });

  it("does not apply a second choice from the same idea after the first tap", () => {
    const applyAction = vi.fn();
    render(<FoodIdeasBlock block={{ ...twoIdeas, ideas: [twoIdeas.ideas[0]] }}
      ctx={blockContext({ applyAction })} />);

    const log = screen.getByRole("button", { name: "Log it" });
    const recipe = screen.getByRole("button", { name: "Save as recipe" });
    fireEvent.click(log);
    fireEvent.click(recipe);

    expect(applyAction).toHaveBeenCalledOnce();
    expect(applyAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "log_meal" }));
  });
});
