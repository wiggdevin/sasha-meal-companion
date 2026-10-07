/**
 * The suggestion time budget: building stops at SUGGEST_BUILD_BUDGET_MS and keeps what it has, so
 * the evidence check and the Jev ranking still run inside the 8 s total. A card never shows without
 * its evidence check. Production, 2026-09-29/30: a 40-food Eats list spent the whole budget
 * searching and the Plan sheet answered with zero cards.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import type { FoodHit } from "@/lib/coach/executors";
import { SUGGEST_BUILD_BUDGET_MS, suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const TARGET = { kcal: 480, protein: 50, carbs: 50, fat: 8 };
const TIMEOUT_MESSAGE = "I ran out of time building options — ask again in a moment.";

function protein(index: number): FoodHit {
  return {
    foodRefId: `3f1b1a2c-0000-4000-8000-00000000002${index}`, name: `Protein ${index}`,
    brand: null, kcalPer100g: 240, proteinPer100g: 25, carbsPer100g: 25, fatPer100g: 4,
    prefStatus: "eats", catalogFoodRevisionId: index, allergenTags: [],
    checkedAllergens: ["gluten", "dairy", "apple"], category: [], portionGrams: 120,
  };
}

const natural = { type: "score" as const, score: 2, legend: { "0": "not", "1": "ok", "2": "natural" },
  probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 };

function fixture(foods: FoodHit[]): SuggestPorts & { jev: ReturnType<typeof vi.fn> } {
  const byName = new Map(foods.map((hit) => [hit.name, hit]));
  const jev = vi.fn(async (payload: { questions: Record<string, unknown> }) =>
    Object.fromEntries(Object.keys(payload.questions).map((key) => [key, natural])));
  return {
    jev,
    userId: "u1", profile: TEST_PROFILE, target: async () => TARGET,
    eatsNames: async () => foods.map((hit) => hit.name),
    searchFoods: vi.fn(async (_userId: string, query: string) => {
      const hit = byName.get(query);
      return hit ? [hit] : [];
    }),
    systemOne: jev as unknown as SuggestPorts["systemOne"],
    suggestionEvidence: async (_userId, items) => ({
      status: "ready", preferenceFlags: [],
      byIdentity: Object.fromEntries(items.map((item) => [suggestionFoodIdentity(item), {
        allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"], policyCategories: [],
        noCook: null, onEatsList: true, onAvoidList: false, role: "protein",
        facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } },
      }])),
    }),
  };
}

/** Eats names after the real foods whose searches never answer. */
function withSlowNames(ports: SuggestPorts, foods: FoodHit[], slow: number): void {
  ports.eatsNames = async () => [...foods.map((hit) => hit.name),
    ...Array.from({ length: slow }, (_, index) => `Slow ${index}`)];
  ports.searchFoods = vi.fn(async (_userId: string, query: string) =>
    foods.find((hit) => hit.name === query) ? [foods.find((hit) => hit.name === query)!]
      : new Promise<FoodHit[]>(() => {}));
}

async function settle(pending: Promise<unknown>, ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  return pending;
}

describe("suggestOptions time budget", () => {
  it("stops building at the build budget and still checks and ranks the cards it has", async () => {
    vi.useFakeTimers();
    try {
      const foods = [protein(1), protein(2)];
      const ports = fixture(foods);
      withSlowNames(ports, foods, 6);

      const cards = await settle(suggestOptions({ kind: "meal", count: 3 }, ports),
        SUGGEST_BUILD_BUDGET_MS) as Awaited<ReturnType<typeof suggestOptions>>;

      expect(cards.map((card) => card.anchorProtein)).toEqual(["Protein 1", "Protein 2"]);
      expect(ports.jev).toHaveBeenCalledOnce();
      expect(cards).toMatchObject({
        partial: true, message: "Here are the 2 I could build in time — ask again for more.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("withholds built cards when the evidence check outlasts the eight-second budget", async () => {
    vi.useFakeTimers();
    try {
      const foods = [protein(1)];
      const ports = fixture(foods);
      withSlowNames(ports, foods, 1);
      ports.suggestionEvidence = () => new Promise(() => {});

      const cards = await settle(suggestOptions({ kind: "meal", count: 2 }, ports), 8_000);

      expect(JSON.parse(JSON.stringify(cards))).toEqual({
        cards: [], partial: true, message: TIMEOUT_MESSAGE,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the honest retry line when the budget expires before any card is built", async () => {
    vi.useFakeTimers();
    try {
      const ports = fixture([protein(1)]);
      ports.target = async () => new Promise(() => {});

      const cards = await settle(suggestOptions({ kind: "meal", count: 2 }, ports), 8_000);

      expect(cards).toHaveLength(0);
      expect(JSON.parse(JSON.stringify(cards))).toEqual({
        cards: [], partial: true, message: TIMEOUT_MESSAGE,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("searches each Eats food for at most three anchors", async () => {
    const ports = fixture(Array.from({ length: 6 }, (_, index) => protein(index + 1)));
    const search = ports.searchFoods as ReturnType<typeof vi.fn>;

    const cards = await suggestOptions({ kind: "meal", count: 5 }, ports);

    expect(cards).toHaveLength(5);
    expect(Math.max(...search.mock.calls.map((call) => call[2] as number))).toBeLessThanOrEqual(3);
  });
});
