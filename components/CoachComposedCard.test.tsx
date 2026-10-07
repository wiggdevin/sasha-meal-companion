// @vitest-environment jsdom
/**
 * Phase 18 W6 UI: a coach suggestion card "picks" on a committing tap (Log it / Put it in <slot>),
 * reporting the suggestion's own occasion — not the tap's clock (Sol review r3 WARN). Tested
 * directly against the component (not through the `food_ideas` block): `composedMealSchema`
 * (lib/coach/ui-blocks.ts) carries no `mealType`/`mealClock` field, so an idea routed through that
 * block can never exercise this path today — a lib gap reported as UI-NEEDS, not fixed here.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ foodSignal: vi.fn(), sendFoodSignals: vi.fn() }));
vi.mock("@/lib/foods/signals-client", () => ({
  foodSignal: (input: unknown, now?: Date) => mocked.foodSignal(input, now),
  sendFoodSignals: (events: unknown) => mocked.sendFoodSignals(events),
}));

import CoachComposedCard, { fitLine, isIncompleteDraft } from "@/components/CoachComposedCard";
import type { ComposedMeal } from "@/lib/coach/compose";

afterEach(cleanup);
beforeEach(() => {
  mocked.foodSignal.mockReset().mockImplementation((input) => ({ ...input, clientEventId: "evt", at: "2026-10-06T18:00:00Z" }));
  mocked.sendFoodSignals.mockReset().mockResolvedValue(true);
});

function meal(wish: string, foodKey?: string, mealType?: ComposedMeal["mealType"],
  mealClock?: string | null): ComposedMeal {
  return {
    wish, slot: null, flagged: [], fitsTarget: true,
    target: { kcal: 400, protein: 30, carbs: 50, fat: 10 },
    totals: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 },
    items: [{ name: "Oatmeal", foodRefId: "ref-1", catalogFoodRevisionId: null, grams: 180,
      kcalPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3,
      macros: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 }, verdict: "allowed",
      ...(foodKey ? { foodKey } : {}) }],
    ...(mealType ? { mealType } : {}), ...(mealClock !== undefined ? { mealClock } : {}),
  } as ComposedMeal;
}

describe("CoachComposedCard signals", () => {
  it("reports the suggestion's own mealType, not the tap's clock", () => {
    const keyed = meal("Oatmeal", "food:11111111-1111-4111-8111-111111111111", "breakfast");
    render(<CoachComposedCard meal={keyed} tz="UTC" onAction={vi.fn()}
      slate={[keyed]} slateId="s1"
      now={() => new Date("2026-10-06T23:00:00Z")} />);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1);
    const [event] = mocked.sendFoodSignals.mock.calls[0][0];
    // 23:00 UTC alone would read as "dinner" (lib/meals/occasion.ts bands) — proving mealType,
    // not the tap clock, decided this.
    expect(event.occasion).toBe("breakfast");
  });

  it("falls back to the suggestion's own mealClock when it carries no mealType", () => {
    const keyed = meal("Oatmeal", "food:11111111-1111-4111-8111-111111111111", undefined, "07:30");
    render(<CoachComposedCard meal={keyed} tz="UTC" onAction={vi.fn()}
      slate={[keyed]} slateId="s1"
      now={() => new Date("2026-10-06T23:00:00Z")} />);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    const [event] = mocked.sendFoodSignals.mock.calls[0][0];
    expect(event.occasion).toBe("breakfast");
  });

  it("sends nothing when no slate/slateId is passed (an existing caller's behavior is unchanged)", () => {
    const keyed = meal("Oatmeal", "food:11111111-1111-4111-8111-111111111111", "breakfast");
    render(<CoachComposedCard meal={keyed} tz="UTC" onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    expect(mocked.sendFoodSignals).not.toHaveBeenCalled();
  });
});

/** Phase 18 W9 (UI-NEEDS, Sol r1 BLOCK): a direct wish with no coherent plate. Every named food
 *  is still kept in `items`, each at grams:0/macros:0, with `fitsTarget: false, fitNote: null`. */
function incompleteMeal(reason: string): ComposedMeal {
  return {
    wish: "turkey and oatmeal", slot: null, flagged: [], fitsTarget: false, fitNote: null,
    incomplete: { reason },
    target: { kcal: 400, protein: 30, carbs: 50, fat: 10 },
    totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    items: [
      { name: "Turkey", foodRefId: "ref-1", catalogFoodRevisionId: null, grams: 0,
        kcalPer100g: 0, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0,
        macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, verdict: "allowed" },
      { name: "Oatmeal", foodRefId: "ref-2", catalogFoodRevisionId: null, grams: 0,
        kcalPer100g: 0, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0,
        macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, verdict: "allowed" },
    ],
  } as ComposedMeal;
}

describe("fitLine", () => {
  it("shows the incomplete reason, not the generic fit-fail fallback", () => {
    const line = fitLine({ fitsTarget: false, fitNote: null, incomplete: { reason: "No coherent plate holds every named food" } });
    expect(line).toBe("Couldn't make a full meal from those: No coherent plate holds every named food");
  });

  it("still falls back to the generic line for an ordinary fit miss (no incomplete)", () => {
    expect(fitLine({ fitsTarget: false, fitNote: null })).toBe("This does not quite fit the slot");
  });
});

describe("isIncompleteDraft", () => {
  it("is true for meal.incomplete", () => {
    expect(isIncompleteDraft(incompleteMeal("x"))).toBe(true);
  });

  it("is true for an all-zero-gram draft with no incomplete flag", () => {
    const meal = incompleteMeal("x");
    delete (meal as { incomplete?: unknown }).incomplete;
    expect(isIncompleteDraft(meal)).toBe(true);
  });

  it("is false for an ordinary sized draft", () => {
    expect(isIncompleteDraft(meal("Oatmeal"))).toBe(false);
  });
});

describe("CoachComposedCard, an incomplete draft (Phase 18 W9)", () => {
  it("shows the incomplete reason instead of the generic fit-fail line", () => {
    render(<CoachComposedCard meal={incompleteMeal("No coherent plate holds every named food")}
      tz="UTC" onAction={vi.fn()} />);
    expect(screen.getByText("Couldn't make a full meal from those: No coherent plate holds every named food"))
      .toBeTruthy();
    expect(screen.queryByText("This does not quite fit the slot")).toBeNull();
  });

  it("hides Log it, Put in slot and Save as recipe", () => {
    render(<CoachComposedCard meal={{ ...incompleteMeal("x"), slot: "meal-1" }} tz="UTC" onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Log it" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Put it in/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save as recipe" })).toBeNull();
  });

  it("hides the multi-slot picker too", () => {
    const withSlots = { ...incompleteMeal("x"), slot: "meal-1",
      pendingSlots: [{ slot: "meal-1", label: "Meal 1" }, { slot: "meal-2", label: "Meal 2" }] };
    render(<CoachComposedCard meal={withSlots} tz="UTC" onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Meal 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Meal 2" })).toBeNull();
  });

  it("hides the macro/kcal nutrition panel, which would otherwise read as a measured 0/0/0/0", () => {
    render(<CoachComposedCard meal={incompleteMeal("x")} tz="UTC" onAction={vi.fn()} />);
    expect(screen.queryByText("fits what is left")).toBeNull();
    expect(screen.queryByText(/target \d+ kcal/)).toBeNull();
  });

  it("hides the three actions for a zero-gram draft even without the incomplete flag", () => {
    const meal = incompleteMeal("x");
    delete (meal as { incomplete?: unknown }).incomplete;
    render(<CoachComposedCard meal={meal} tz="UTC" onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Log it" })).toBeNull();
  });

  it("still shows every named food, each with its own grams", () => {
    render(<CoachComposedCard meal={incompleteMeal("x")} tz="UTC" onAction={vi.fn()} />);
    expect(screen.getByText("Turkey")).toBeTruthy();
    expect(screen.getByText("Oatmeal")).toBeTruthy();
  });
});
