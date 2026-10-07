// @vitest-environment jsdom
/**
 * Phase 18 W6 UI: a coach suggestion card (the food_ideas block) "picks" on a committing tap, with
 * the suggestion's own occasion (not the tap's). An idea the server could not ground to a food
 * (no `foodKey` on any of its items) sends nothing — proven here, alongside the keyed case that
 * proves the wiring itself works.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ foodSignal: vi.fn(), sendFoodSignals: vi.fn() }));
vi.mock("@/lib/foods/signals-client", () => ({
  foodSignal: (input: unknown, now?: Date) => mocked.foodSignal(input, now),
  sendFoodSignals: (events: unknown) => mocked.sendFoodSignals(events),
}));

import FoodIdeasBlock from "@/components/coach/blocks/food_ideas";
import type { FoodIdeasBlockV1 } from "@/lib/coach/ui-blocks";
import { blockContext } from "@/tests/coach/blocks-client/fixtures";

afterEach(cleanup);
beforeEach(() => {
  mocked.foodSignal.mockReset().mockImplementation((input) => ({ ...input, clientEventId: "evt", at: "2026-10-06T18:00:00Z" }));
  mocked.sendFoodSignals.mockReset().mockResolvedValue(true);
});

function idea(name: string, ref: string, foodKey?: string): FoodIdeasBlockV1["ideas"][number] {
  const base = {
    wish: name, slot: "meal-2", items: [{
      name, foodRefId: ref, catalogFoodRevisionId: 71, grams: 180,
      kcalPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3,
      macros: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 }, verdict: "allowed",
      ...(foodKey ? { foodKey } : {}),
    }],
    totals: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 },
    target: { kcal: 400, protein: 30, carbs: 50, fat: 10 },
    flagged: [], fitsTarget: true,
  };
  return base as unknown as FoodIdeasBlockV1["ideas"][number];
}

describe("food ideas block signals", () => {
  it("sends nothing on 'Log it' for an idea the server could not ground to a food (no foodKey)", () => {
    const block: FoodIdeasBlockV1 = { kind: "food_ideas", v: 1, id: "ideas-1",
      ideas: [idea("Rice bowl", "11111111-1111-4111-8111-111111111111")] };
    render(<FoodIdeasBlock block={block} ctx={blockContext()} />);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    expect(mocked.sendFoodSignals).not.toHaveBeenCalled();
  });

  it("sends 'picked' with the slate's keys once an idea carries a resolvable key", () => {
    const block: FoodIdeasBlockV1 = { kind: "food_ideas", v: 1, id: "ideas-2", ideas: [
      idea("Rice bowl", "11111111-1111-4111-8111-111111111111", "food:11111111-1111-4111-8111-111111111111"),
      idea("Chicken plate", "22222222-2222-4222-8222-222222222222", "catalog:42"),
    ] };
    render(<FoodIdeasBlock block={block} ctx={blockContext()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Log it" })[0]);

    expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1);
    const [event] = mocked.sendFoodSignals.mock.calls[0][0];
    expect(event).toMatchObject({ slateId: "ideas-2", surface: "suggestion_card", kind: "picked",
      chosenKey: "food:11111111-1111-4111-8111-111111111111",
      offeredKeys: ["food:11111111-1111-4111-8111-111111111111", "catalog:42"] });
  });

  // The occasion fix (CoachComposedCard reading meal.mealType/mealClock instead of the tap's own
  // clock) is covered directly against CoachComposedCard in CoachComposedCard.test.tsx, not here:
  // `composedMealSchema` (lib/coach/ui-blocks.ts), which this block's ideas are parsed through,
  // carries no `mealType`/`mealClock` field, so a food_ideas idea can never exercise that path —
  // a lib gap reported as UI-NEEDS, not fixed in this diff.
});
