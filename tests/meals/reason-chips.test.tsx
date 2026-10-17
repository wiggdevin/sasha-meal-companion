// @vitest-environment jsdom
/**
 * W099: the reason chips the engine already emits ("You eat this often", "Favorite") reach the
 * meal card, the swap row and the coach composed card, complete and incomplete alike.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));
vi.mock("@/lib/foods/signals-client", () => ({ foodSignal: vi.fn(), sendFoodSignals: vi.fn() }));

import CoachComposedCard from "@/components/CoachComposedCard";
import ReasonChips from "@/components/meals/ReasonChips";
import { composeMeal, type ComposedMeal } from "@/lib/coach/compose";
import type { FoodHit } from "@/lib/coach/executors";
import { composedMealSchema } from "@/lib/coach/ui-blocks";
import { shownReasonChips } from "@/lib/meals/reason-chips";
import { inputsFor, openSnapshot } from "@/tests/helpers/open-snapshot";

afterEach(cleanup);

describe("ReasonChips", () => {
  it("shows each chip in its own words", () => {
    render(<ReasonChips reasons={["on_list", "eaten_often"]} />);
    expect(screen.getByText("You eat this often")).toBeTruthy();
    expect(screen.getByText("Favorite")).toBeTruthy();
  });

  it("renders nothing with no reason", () => {
    const { container } = render(<><ReasonChips /><ReasonChips reasons={[]} /></>);
    expect(container.innerHTML).toBe("");
  });

  it("drops an unknown chip and repeats none", () => {
    expect(shownReasonChips(["on_list", "bogus", "on_list"])).toEqual(["on_list"]);
  });
});

const ZERO = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
function card(extra: Partial<ComposedMeal>): ComposedMeal {
  return {
    wish: "oatmeal", slot: null, flagged: [], fitsTarget: true,
    target: { kcal: 400, protein: 30, carbs: 50, fat: 10 },
    totals: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 },
    items: [{ name: "Oatmeal", foodRefId: "ref-1", catalogFoodRevisionId: null, grams: 180,
      kcalPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3,
      macros: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 }, verdict: "allowed" }],
    ...extra,
  };
}

describe("CoachComposedCard reason chips", () => {
  it("shows the chips on a complete card", () => {
    render(<CoachComposedCard meal={card({ reasons: ["eaten_often"] })} tz="UTC" onAction={vi.fn()} />);
    expect(screen.getByText("You eat this often")).toBeTruthy();
  });

  it("shows the chips on an incomplete card", () => {
    render(<CoachComposedCard tz="UTC" onAction={vi.fn()} meal={card({
      fitsTarget: false, fitNote: null, incomplete: { reason: "No coherent plate holds every named food" },
      totals: ZERO, reasons: ["on_list"],
      items: [{ name: "Turkey", foodRefId: "ref-1", catalogFoodRevisionId: null, grams: 0, kcalPer100g: 0,
        proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0, macros: ZERO, verdict: "allowed" }] })} />);
    expect(screen.getByText("Favorite")).toBeTruthy();
  });

  it("shows no chip without a reason", () => {
    const { container } = render(<CoachComposedCard meal={card({})} tz="UTC" onAction={vi.fn()} />);
    expect(container.querySelector("[data-reason-chips]")).toBeNull();
  });

  it("keeps known chips through the food_ideas block schema and drops a bad shape", () => {
    expect(composedMealSchema.parse(card({ reasons: ["on_list"] })).reasons).toEqual(["on_list"]);
    expect(composedMealSchema.parse({ ...card({}), reasons: ["eaten_often", "nope"] }).reasons).toEqual(["eaten_often"]);
    expect(composedMealSchema.parse({ ...card({}), reasons: "eaten_often" }).reasons).toBeUndefined();
  });
});

describe("composeMeal reasons", () => {
  const chicken: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-0000000000c1", name: "Chicken breast, grilled",
    brand: null, prefStatus: null, kcalPer100g: 156.4, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
    catalogFoodRevisionId: null, allergenTags: [], category: null };
  const args = { wish: "chicken for dinner", target: { kcal: 650, protein: 45, carbs: 70, fat: 20 } };
  const profile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] };
  const universeRefs = async (_u: string, ids: readonly string[]) => Object.fromEntries(ids.map((id, i) =>
    [id, { foodRefId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, catalogFoodRevisionId: 1 }]));
  const ports = (chips: Record<string, ("eaten_often" | "on_list")[]> | null, refs = universeRefs) => {
    const open = inputsFor(openSnapshot());
    return {
      searchFoods: async (_u: string, q: string) => (q === "chicken" ? [chicken] : []),
      eatsNames: async () => [], pool: async () => ({}), poolRefs: async () => ({}), universeRefs: refs,
      openWorld: async () => (chips ? { ...open, chips: Object.fromEntries(
        [...Object.keys(open.foods), chicken.foodRefId!].map((id) => [id, chips[id] ?? chips["*"] ?? []])) } : null),
    };
  };

  it("carries the plate's chips on an open account", async () => {
    const meal = await composeMeal("u1", args, profile, ports({ "*": ["eaten_often"] }));
    expect(meal.incomplete).toBeUndefined();
    expect(meal.reasons).toEqual(["eaten_often"]);
  });

  it("carries the named foods' chips on an incomplete draft", async () => {
    const meal = await composeMeal("u1", args, profile, ports({ [chicken.foodRefId!]: ["on_list"] }, async () => ({})));
    expect(meal.incomplete).toBeDefined();
    expect(meal.reasons).toEqual(["on_list"]);
  });

  it("carries none on a closed account", async () => {
    const meal = await composeMeal("u1", args, profile, { ...ports(null), pool: async () => ({}) });
    expect(meal.reasons).toBeUndefined();
  });
});
