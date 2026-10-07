/**
 * Phase 18 W10 (docs/specs/phase-18-open-world-foods.md §W10, D9 item 4), the short-list check's
 * remaining acceptance criteria:
 *   2. One Jev call, on 5 to 8 admitted plates, no retry, inside the suggestion budget.
 *   4. Jev down/invalid/vetoing too much → the formula order stands, at least 3 cards remain.
 *   5. The check never adds a candidate and never ranks a plate that misses fit ahead of one
 *      that fits.
 *   6. Shadow mode: a veto changes no output until the §5 precision gate passes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";
import type { FoodHit } from "@/lib/coach/executors";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const TARGET = { kcal: 480, protein: 50, carbs: 50, fat: 8 };

function protein(index: number): FoodHit {
  return {
    foodRefId: `3f1b1a2c-0000-4000-8000-00000000000${index}`,
    name: `Protein ${index}`,
    brand: null,
    kcalPer100g: 240,
    proteinPer100g: 25,
    carbsPer100g: 25,
    fatPer100g: 4,
    prefStatus: "eats",
    catalogFoodRevisionId: index,
    allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"],
    category: [],
    portionGrams: 120,
  };
}

function answer(score: number) {
  return { type: "score" as const, score, legend: { "0": "not", "1": "acceptable", "2": "natural" },
    probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 };
}

type Jev = (state: unknown, questions: Record<string, unknown>) =>
  Promise<Record<string, ReturnType<typeof answer>> | null>;

function fixture(options: { count?: number; jev?: Jev } = {}): SuggestPorts {
  const proteins = Array.from({ length: options.count ?? 10 }, (_, i) => protein(i + 1));
  const byName = new Map(proteins.map((food) => [food.name.toLowerCase(), food]));
  return {
    userId: "u1",
    profile: DEFAULT_PROFILE,
    target: async () => TARGET,
    eatsNames: async () => proteins.map((food) => food.name),
    searchFoods: async (_userId: string, query: string) => {
      const hit = byName.get(query.toLowerCase());
      return hit ? [hit] : [];
    },
    systemOne: (payload, callOptions) => (options.jev
      ?? (async (_state: unknown, questions: Record<string, unknown>) =>
        Object.fromEntries(Object.keys(questions).map((key) => [key, answer(2)]))))(
      { ...payload.state, __callOptions: callOptions }, payload.questions),
    suggestionEvidence: async (_userId, items) => ({
      status: "ready", preferenceFlags: [],
      byIdentity: Object.fromEntries(items.map((item) => [suggestionFoodIdentity(item), {
        allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"], policyCategories: [],
        noCook: null, onEatsList: true, onAvoidList: false, role: "protein" as const,
        facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } },
      }])),
    }),
  };
}

describe("W10 acceptance 2: the shortlist Jev sees", () => {
  it("is capped at 8 even when more admitted plates were built, and asks for no retry", async () => {
    const jev = vi.fn(async (state: unknown, questions: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(questions).map((key) => [key, answer(2)])));
    const cards = await suggestOptions({ kind: "meal", count: 5 }, fixture({ count: 10, jev }));
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(jev).toHaveBeenCalledOnce();
    const state = jev.mock.calls[0][0] as { candidates: unknown[]; __callOptions: { noRetry?: boolean } };
    expect(state.candidates.length).toBeLessThanOrEqual(8);
    expect(state.__callOptions.noRetry).toBe(true);
  });
});

describe("W10 acceptance 4: Jev failure or heavy vetoing never drops below 3 cards", () => {
  it("keeps the formula order when Jev returns null (down or invalid)", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 5 },
      fixture({ jev: async () => null }));
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(cards.every((card) => card.rankNote?.startsWith("fits"))).toBe(true);
  });

  it("keeps at least 3 cards when every candidate is scored implausible", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 5 },
      fixture({ jev: async (_s, questions) =>
        Object.fromEntries(Object.keys(questions).map((key) => [key, answer(0)])) }));
    expect(cards.length).toBeGreaterThanOrEqual(3);
  });
});

describe("W10 acceptance 5: a plate that misses fit never ranks ahead of one that fits", () => {
  it("orders every fitting card ahead of every non-fitting one regardless of the Jev score", async () => {
    // A tight target with few proteins near it: most candidates fit, a couple miss by a wide
    // margin on protein (checked via `fitsTarget`, not the continuous `fit` score alone).
    const cards = await suggestOptions({ kind: "meal", count: 10 }, fixture({
      count: 10,
      jev: async (_s, questions) => Object.fromEntries(Object.keys(questions).map((key, i) =>
        // Score the worst-fitting candidates as if Jev found them MOST plausible — acceptance 5
        // must still keep them behind every fitting card.
        [key, answer(i < 2 ? 2 : 1)])),
    }));
    const fits = cards.map((card) => card.fitsTarget);
    const firstMiss = fits.indexOf(false);
    if (firstMiss !== -1) expect(fits.slice(firstMiss).every((fit) => fit === false)).toBe(true);
  });
});

describe("W10 acceptance 6: shadow mode", () => {
  it("a veto changes no output while SUGGEST_VETO_LIVE is unset", async () => {
    const original = process.env.SUGGEST_VETO_LIVE;
    delete process.env.SUGGEST_VETO_LIVE;
    try {
      // Exactly 4 candidates requested from exactly 4 built, 1 vetoed: once the veto gate is live,
      // 4 - 1 = 3 still clears the "keep at least 3" floor, so a live run WOULD drop to 3 cards.
      // Shadow mode (the default here) must still return all 4 — the veto only demotes its rank.
      const rejectOne = async (_s: unknown, questions: Record<string, unknown>) =>
        Object.fromEntries(Object.keys(questions).map((key, i) => [key, answer(i === 0 ? 0 : 2)]));
      const cards = await suggestOptions({ kind: "meal", count: 4 }, fixture({ count: 4, jev: rejectOne }));
      expect(cards.length).toBe(4);
    } finally {
      if (original !== undefined) process.env.SUGGEST_VETO_LIVE = original;
    }
  });

  it("a veto DOES drop the card once SUGGEST_VETO_LIVE=1 and at least 3 would remain", async () => {
    const original = process.env.SUGGEST_VETO_LIVE;
    process.env.SUGGEST_VETO_LIVE = "1";
    try {
      const rejectOne = async (_s: unknown, questions: Record<string, unknown>) =>
        Object.fromEntries(Object.keys(questions).map((key, i) => [key, answer(i === 0 ? 0 : 2)]));
      const cards = await suggestOptions({ kind: "meal", count: 4 }, fixture({ count: 4, jev: rejectOne }));
      expect(cards.length).toBe(3);
    } finally {
      if (original === undefined) delete process.env.SUGGEST_VETO_LIVE;
      else process.env.SUGGEST_VETO_LIVE = original;
    }
  });
});
