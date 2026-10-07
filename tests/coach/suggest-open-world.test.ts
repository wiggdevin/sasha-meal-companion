/**
 * Phase 18 W10 (docs/specs/phase-18-open-world-foods.md §W10), acceptance 1: an open account with
 * 0 Favored foods still gets suggestion cards — built from `rankPlates`' best plate per anchor
 * over the admitted universe pool (`lib/coach/suggest-pool.ts`), the SAME fresh admission read
 * `lib/meals/open-world.ts`'s `openWorldInputs` already proves for the daily layout and the swap
 * sheet (tests/meals/open-world-layout.test.ts acceptance 1).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import { inputsFor, openSnapshot, ownFood } from "@/tests/helpers/open-snapshot";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const TARGET = { kcal: 500, protein: 35, carbs: 52.5, fat: 16.7 };

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
