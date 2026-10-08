/**
 * Phase 18 W10 (docs/specs/phase-18-open-world-foods.md §W10), acceptance 1: an open account with
 * 0 Favored foods still gets suggestion cards — built from `rankPlates`' best plate per anchor
 * over the admitted universe pool (`lib/coach/suggest-pool.ts`), the SAME fresh admission read
 * `lib/meals/open-world.ts`'s `openWorldInputs` already proves for the daily layout and the swap
 * sheet (tests/meals/open-world-layout.test.ts acceptance 1).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import { composeMeal } from "@/lib/coach/compose";
import type { FoodHit } from "@/lib/coach/executors";
import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import { inputsFor, openSnapshot, ownFood } from "@/tests/helpers/open-snapshot";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const TARGET = { kcal: 500, protein: 35, carbs: 52.5, fat: 16.7 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A fake catalog-ref mint (lib/server/universe-refs.ts): one stable uuid per universe pool id. */
const fakeUniverseRefs: NonNullable<SuggestPorts["universeRefs"]> = async (_user, ids) =>
  Object.fromEntries(ids.map((id) => {
    const n = [...id].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 1e12, 7);
    return [id, { foodRefId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, catalogFoodRevisionId: 1 + (n % 9000) }];
  }));

function openPorts(overrides: Partial<SuggestPorts> = {}): SuggestPorts {
  const open = inputsFor(openSnapshot());
  return {
    userId: "u1",
    profile: DEFAULT_PROFILE,
    target: async () => TARGET,
    eatsNames: async () => [],
    searchFoods: async () => [],
    openWorld: async () => open,
    poolRefs: async () => ({}),
    universeRefs: fakeUniverseRefs,
    ...overrides,
  };
}

describe("W10 acceptance 1: an open account with 0 Favored foods", () => {
  it("gets at least 3 admitted cards for a meal occasion", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 3, slot: "meal-2" }, openPorts());
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(cards.every((card) => card.items.length > 0)).toBe(true);
    expect(cards.every((card) => card.items.every((item) => item.verdict === "allowed"))).toBe(true);
  });

  it("gets at least 3 admitted cards for a snack occasion", async () => {
    const cards = await suggestOptions({ kind: "snack", count: 3, slot: "meal-4" },
      openPorts({ target: async () => ({ kcal: 220, protein: 10, carbs: 25, fat: 8 }) }));
    expect(cards.length).toBeGreaterThanOrEqual(3);
  });

  it("never anchors on the same food twice across the cards it returns", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 5, slot: "meal-1" }, openPorts());
    const anchors = cards.map((card) => card.items.find((item) => item.part === "anchor")?.name);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});

describe("a universe row is committable: every card item carries a real food ref", () => {
  it("puts the minted catalog ref and its revision on each universe row, never the pool id", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 5, slot: "meal-2" }, openPorts());
    expect(cards.length).toBeGreaterThanOrEqual(3);
    for (const item of cards.flatMap((card) => card.items)) {
      expect([item.name, UUID.test(item.foodRefId)]).toEqual([item.name, true]);
      expect(item.catalogFoodRevisionId).toEqual(expect.any(Number));
    }
    // Universe rows are not the person's Favorites: the "from your Favorites" copy stays off.
    expect(cards.every((card) => card.allItemsOnEats === false)).toBe(true);
  });

  it("leaves out a plate whose universe row could not be resolved, rather than a card that cannot log", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 5, slot: "meal-2" },
      openPorts({ universeRefs: async () => ({}) }));
    expect(cards.flatMap((card) => card.items).some((item) => item.foodRefId.startsWith("universe:"))).toBe(false);
  });
});

describe("compose_meal on an open account: pool-filled universe rows are committable", () => {
  const chicken: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-0000000000c1", name: "Chicken breast, grilled",
    brand: null, prefStatus: null, kcalPer100g: 156.4, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
    catalogFoodRevisionId: null, allergenTags: [], category: null };
  const args = { wish: "chicken for dinner", target: { kcal: 650, protein: 45, carbs: 70, fat: 20 } };
  const ports = (universeRefs: SuggestPorts["universeRefs"]) => ({
    searchFoods: async (_u: string, q: string) => (q === "chicken" ? [chicken] : []),
    eatsNames: async () => [], pool: async () => ({}), poolRefs: async () => ({}),
    openWorld: async () => inputsFor(openSnapshot()), universeRefs,
  });
  const open = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] };

  it("fills the plate from the universe and gives every row a real ref", async () => {
    const meal = await composeMeal("u1", args, open, ports(fakeUniverseRefs));
    expect(meal.incomplete).toBeUndefined();
    expect(meal.items.length).toBeGreaterThan(1);
    expect(meal.items.every((item) => UUID.test(item.foodRefId))).toBe(true);
  });

  it("returns the incomplete draft, not a card that cannot log, when a universe row has no ref", async () => {
    const meal = await composeMeal("u1", args, open, ports(async () => ({})));
    expect(meal.incomplete?.reason).toMatch(/couldn't look up/);
    expect(meal.fitsTarget).toBe(false);
    expect(meal.items.every((item) => UUID.test(item.foodRefId))).toBe(true);
  });
});

describe("W10 acceptance 3: a Favored account row stays out of the Jev shortlist", () => {
  it("never sends a plate holding the account's own Favored food to Jev", async () => {
    const chicken = ownFood("11111111-1111-4111-8111-111111111111", "Chicken breast, grilled",
      "protein", [31, 0, 3.6]);
    const open = inputsFor(openSnapshot({ favored: [chicken] }), [chicken]);
    const seen: { foods: { name: string }[] }[][] = [];
    const jev: SuggestPorts["systemOne"] = async (payload) => {
      const state = payload.state as unknown as { candidates: { foods: { name: string }[] }[] };
      seen.push(state.candidates);
      return Object.fromEntries(Object.keys(payload.questions).map((key) => [key, {
        type: "score" as const, score: 2, legend: { "0": "not", "1": "acceptable", "2": "natural" },
        probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1,
      }]));
    };
    const cards = await suggestOptions({ kind: "meal", count: 5, slot: "meal-1" },
      openPorts({ openWorld: async () => open, systemOne: jev }));
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(1);
    const jevNames = seen[0].flatMap((candidate) => candidate.foods.map((food) => food.name));
    expect(jevNames).not.toContain("Chicken breast, grilled");
  });
});
