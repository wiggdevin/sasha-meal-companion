/**
 * Phase 18 W11 through the coach generators (Sol W11 r1 BLOCK 1): `compose_meal` and
 * `suggest_options` read the account's shopping focus through the `focus` port
 * (lib/server/compose-pool-ports.ts) and rank by (fits, coverage, score). Without the port, or with
 * focus off, the cards are unchanged.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import { composeMeal } from "@/lib/coach/compose";
import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import type { FoodHit } from "@/lib/coach/executors";
import type { FocusRanking } from "@/lib/meals/plate";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { coverageOf, focusNameKey } from "@/lib/shopping/focus";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";
import { eats, F } from "@/tests/helpers/meal-foods";
import { inputsFor, openSnapshot } from "@/tests/helpers/open-snapshot";

const focusOver = (names: string[]): FocusRanking => {
  const used = new Set(names.map(focusNameKey));
  return { coverageOf: (items) => coverageOf(items, used) };
};

describe("suggest_options under focus (open pool)", () => {
  const TARGET = { kcal: 500, protein: 35, carbs: 52.5, fat: 16.7 };
  const open = inputsFor(openSnapshot());
  const ports = (overrides: Partial<SuggestPorts> = {}): SuggestPorts => ({
    userId: "u1", profile: TEST_PROFILE, target: async () => TARGET, eatsNames: async () => [],
    searchFoods: async () => [], openWorld: async () => open, poolRefs: async () => ({}), ...overrides,
  });
  const anchor = (card: { items: { part?: string; name: string }[] }) =>
    card.items.find((item) => item.part === "anchor")?.name;

  it("puts a fully covered card first, reading the focus once", async () => {
    const plain = await suggestOptions({ kind: "meal", count: 3, slot: "meal-2" }, ports());
    const plainFirst = anchor(plain[0]) as string;
    const pool = Object.values(open.foods).map((food) => food.name).filter((name) => name !== plainFirst);
    const focus = vi.fn(async () => focusOver(pool));
    const cards = await suggestOptions({ kind: "meal", count: 3, slot: "meal-2" }, ports({ focus }));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(anchor(cards[0])).not.toBe(plainFirst);
    expect(cards[0].items.every((item) => item.name !== plainFirst)).toBe(true);
  });

  it("is unchanged when the port answers no focus", async () => {
    const plain = await suggestOptions({ kind: "meal", count: 3, slot: "meal-2" }, ports());
    const same = await suggestOptions({ kind: "meal", count: 3, slot: "meal-2" },
      ports({ focus: async () => undefined }));
    expect(same.map(anchor)).toEqual(plain.map(anchor));
  });
});

describe("compose_meal under focus", () => {
  const OPEN_PROFILE: ConstraintProfile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] };
  const chicken: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-0000000000c1", name: F.chicken.name,
    brand: null, prefStatus: "eats", kcalPer100g: 156.4, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
    catalogFoodRevisionId: null, allergenTags: [], category: null };
  const base = {
    searchFoods: async (_u: string, q: string) => (q === "chicken" ? [chicken] : []),
    eatsNames: async () => [],
    pool: async () => eats(F.rice, F.bread, F.toast, F.broccoli, F.tomato, F.oliveOil),
  };
  const args = { wish: "chicken for dinner", target: { kcal: 650, protein: 45, carbs: 70, fat: 20 } };
  const names = (meal: { items: { name: string }[] }) => meal.items.map((item) => item.name);

  it("swaps the plate's main side for a list food when focus is on", async () => {
    const plain = await composeMeal("u1", args, OPEN_PROFILE, base);
    // The plain plate's biggest side (by calories) is not on the list; everything else is.
    const side = plain.items.filter((item) => item.name !== F.chicken.name)
      .sort((a, b) => b.macros.kcal - a.macros.kcal)[0].name;
    const listed = [F.chicken, F.rice, F.bread, F.toast, F.broccoli, F.tomato, F.oliveOil]
      .map((food) => food.name).filter((name) => name !== side);
    const focused = await composeMeal("u1", args, OPEN_PROFILE, { ...base, focus: async () => focusOver(listed) });
    expect(names(focused)).toContain(F.chicken.name);
    expect(names(focused)).not.toContain(side);
    const same = await composeMeal("u1", args, OPEN_PROFILE, { ...base, focus: async () => undefined });
    expect(names(same)).toEqual(names(plain));
  });
});
