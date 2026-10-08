import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({
  score: (instructions: string, criteria: readonly string[]) => ({
    type: "score", instructions, criteria,
  }),
  systemOne: vi.fn(async () => null),
}));

import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import { collectComposed } from "@/lib/coach/turn";
import { NO_MEAL_FIT_MESSAGE } from "@/lib/coach/suggest-messages";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";
import type { FoodHit } from "@/lib/coach/executors";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const TARGET = { kcal: 480, protein: 50, carbs: 50, fat: 8 };
function protein(index: number, kcalPer100g = 240): FoodHit {
  return {
    foodRefId: `3f1b1a2c-0000-4000-8000-00000000000${index}`,
    name: `Protein ${index}`,
    brand: null,
    kcalPer100g,
    proteinPer100g: 25,
    carbsPer100g: 25,
    fatPer100g: 4,
    prefStatus: "eats",
    catalogFoodRevisionId: index,
    allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"], // §5: labels checked
    category: [],
    portionGrams: 120,
  };
}

function answer(score: number) {
  return {
    type: "score" as const,
    score,
    legend: { "0": "not", "1": "acceptable", "2": "natural" },
    probabilities: { "0": 0, "1": 0, "2": 1 },
    confidence: 1,
  };
}

/** W10: a veto only removes/reorders a card once SUGGEST_VETO_LIVE=1 clears the §5 gate. */
async function withVetoLive<T>(run: () => Promise<T>): Promise<T> {
  const original = process.env.SUGGEST_VETO_LIVE;
  process.env.SUGGEST_VETO_LIVE = "1";
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.SUGGEST_VETO_LIVE;
    else process.env.SUGGEST_VETO_LIVE = original;
  }
}

function fixture(options: {
  proteins?: FoodHit[];
  jev?: (state: unknown, questions: Record<string, unknown>) => Promise<Record<string, ReturnType<typeof answer>> | null>;
  target?: typeof TARGET;
} = {}): SuggestPorts {
  const proteins = options.proteins ?? Array.from({ length: 6 }, (_, index) => protein(index + 1));
  const byName = new Map(proteins.map((food) => [food.name.toLowerCase(), food]));
  return {
    userId: "u1",
    profile: DEFAULT_PROFILE,
    target: async () => options.target ?? TARGET,
    eatsNames: async () => proteins.map((food) => food.name),
    searchFoods: vi.fn(async (_userId: string, query: string) => {
      const hit = byName.get(query.toLowerCase());
      return hit ? [hit] : [];
    }),
    systemOne: (payload) => (options.jev ?? (async (_state: unknown, questions: Record<string,
      unknown>) => Object.fromEntries(Object.keys(questions).map((key) => [key, answer(2)]))))(
      payload.state, payload.questions),
    suggestionEvidence: async (_userId, items) => ({
      status: "ready",
      preferenceFlags: [],
      byIdentity: Object.fromEntries(items.map((item) => [suggestionFoodIdentity(item), {
        allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"], policyCategories: [], noCook: null, onEatsList: true, onAvoidList: false, role: "protein", facets: {
          human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" },
        },
      }])),
    }),
  };
}

describe("suggestOptions", () => {
  it("returns five policy-clean target-sized cards with five different protein anchors", async () => {
    const jev = vi.fn(async (_state: unknown, questions: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(questions).map((key) => [key, answer(2)])));

    const cards = await suggestOptions({ kind: "meal", count: 5 }, fixture({ jev }));
    expect(cards).toHaveLength(5);
    expect(new Set(cards.map((card) => card.anchorProtein))).toHaveLength(5);
    expect(cards.every((card) => card.items.every((item) => item.verdict === "allowed"))).toBe(true);
    expect(cards.every((card) => Math.abs(card.totals.kcal - TARGET.kcal) <= TARGET.kcal * 0.15))
      .toBe(true);
    expect(cards.every((card) => card.fitNote === null && card.rankNote)).toBe(true);
    expect(jev).toHaveBeenCalledOnce();
    const [state, questions] = jev.mock.calls[0];
    expect((state as { candidates: unknown[] }).candidates).toHaveLength(6);
    expect(Object.keys(questions)).toHaveLength(6);
  });

  it("searches Eats foods concurrently and reuses each query while composing candidates", async () => {
    const ports = fixture();
    const baseSearch = ports.searchFoods;
    let active = 0;
    let maxActive = 0;
    const calls = new Map<string, number>();
    ports.searchFoods = vi.fn(async (userId, query, limit) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.set(query.toLowerCase(), (calls.get(query.toLowerCase()) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        return await baseSearch(userId, query, limit);
      } finally {
        active -= 1;
      }
    });

    const cards = await suggestOptions({ kind: "meal", count: 5 }, ports);
    expect(cards).toHaveLength(5);
    expect(maxActive).toBeGreaterThan(1);
    expect([...calls.values()].every((count) => count === 1)).toBe(true);
  });

  it("fills lean Eats-list protein suggestions to the meal target before admission", async () => {
    const foods: FoodHit[] = [
      { ...protein(1), name: "Chicken breast, roasted", kcalPer100g: 165,
        proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6, portionGrams: null },
      { ...protein(2), name: "Turkey breast, roasted", kcalPer100g: 135,
        proteinPer100g: 30, carbsPer100g: 0, fatPer100g: 1, portionGrams: null },
      { ...protein(3), name: "Tuna, light, canned in water", kcalPer100g: 116,
        proteinPer100g: 25.5, carbsPer100g: 0, fatPer100g: 0.8, portionGrams: null },
      { ...protein(4), name: "Pork tenderloin, roasted", kcalPer100g: 143,
        proteinPer100g: 26, carbsPer100g: 0, fatPer100g: 3.5, portionGrams: null },
      { ...protein(5), name: "Beef sirloin, grilled", kcalPer100g: 217,
        proteinPer100g: 27, carbsPer100g: 0, fatPer100g: 12, portionGrams: null },
      { ...protein(6), name: "Avocado, raw", kcalPer100g: 160,
        proteinPer100g: 2, carbsPer100g: 8.5, fatPer100g: 14.7, portionGrams: null },
      { ...protein(7), name: "Olive oil", kcalPer100g: 884,
        proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 100, portionGrams: null },
      { ...protein(8), name: "Rice, white, cooked", kcalPer100g: 130,
        proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3, portionGrams: null },
    ];
    const target = { kcal: 522, protein: 37, carbs: 32, fat: 28 };

    const cards = await suggestOptions({ kind: "meal", count: 5 }, fixture({
      proteins: foods,
      target,
    }));
    expect(cards).toHaveLength(5);
    expect(cards.every((card) => Math.abs(card.totals.kcal - target.kcal) <= target.kcal * 0.15))
      .toBe(true);
    expect(cards.every((card) => card.items.length >= 3)).toBe(true);
  });

  it("caps every snack at 300 kcal by scaling the remaining target proportionally", async () => {
    const cards = await suggestOptions({ kind: "snack", count: 5 }, fixture());
    expect(cards).toHaveLength(5);
    expect(cards.every((card) => card.target.kcal === 300)).toBe(true);
    expect(cards.every((card) => card.totals.kcal <= 300)).toBe(true);
  });

  it("keeps a 240 kcal remainder feasible instead of dropping every snack", async () => {
    const remaining = { kcal: 240, protein: 20, carbs: 25, fat: 8 };
    const cards = await suggestOptions({ kind: "snack", count: 1 }, fixture({
      target: remaining,
      proteins: [{ ...protein(1, 240), proteinPer100g: 20, carbsPer100g: 19,
        fatPer100g: 7, portionGrams: 100 }],
    }));

    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards.every((card) => card.target.kcal === 240 && card.totals.kcal <= 240)).toBe(true);
  });

  it("keeps a named-slot snack under the remaining-day cap", async () => {
    const cards = await suggestOptions({ kind: "snack", count: 5, slot: "meal-2" }, fixture({
      target: { kcal: 900, protein: 90, carbs: 120, fat: 30 },
    }));

    expect(cards).toHaveLength(5);
    expect(cards.every((card) => card.target.kcal === 300 && card.totals.kcal <= 300)).toBe(true);
  });

  it("returns zero cards when nothing is left today", async () => {
    const cards = await suggestOptions({ kind: "snack", count: 3 }, fixture({
      target: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    }));

    expect(cards).toEqual([]);
    expect(JSON.parse(JSON.stringify(cards))).toEqual({
      cards: [],
      message: "There are no calories left in today's target for a snack.",
    });
  });

  it("never rounds a snack portion above the 300 kcal ceiling", async () => {
    const cards = await suggestOptions({ kind: "snack", count: 1 }, fixture({
      proteins: [protein(1, 241)],
    }));

    expect(cards).toHaveLength(1);
    expect(cards[0].totals.kcal).toBeLessThanOrEqual(300);
  });

  it("only lifts the snack cap for an explicit portion size", async () => {
    const small = await suggestOptions({ kind: "snack", count: 5, wish: "a small snack" },
      fixture());
    const big = await suggestOptions({ kind: "snack", count: 5, wish: "a big snack" }, fixture());
    const macro = await suggestOptions({ kind: "snack", count: 5, wish: "30 g protein snack" },
      fixture());
    const kcal = await suggestOptions({ kind: "snack", count: 5, wish: "a 450 kcal snack" },
      fixture());
    const grams = await suggestOptions({ kind: "snack", count: 5, wish: "a 150 g snack" },
      fixture());

    expect(small.every((card) => card.target.kcal === 200 && card.totals.kcal <= 200)).toBe(true);
    expect(big.every((card) => card.target.kcal === 300 && card.totals.kcal <= 300)).toBe(true);
    expect(macro.every((card) => card.target.kcal === 300 && card.totals.kcal <= 300)).toBe(true);
    expect(kcal.every((card) => card.target.kcal === 450 && card.totals.kcal <= 450)).toBe(true);
    expect(grams.every((card) => card.target.kcal === TARGET.kcal && card.totals.kcal > 300)).toBe(true);
  });

  it("recomputes the miss line after capping a snack that now fits", async () => {
    const target = { kcal: 24, protein: 2.4, carbs: 2.4, fat: 0.7 };
    const cards = await suggestOptions({ kind: "snack", count: 1 }, fixture({
      target,
      proteins: [{ ...protein(1, 200), proteinPer100g: 20, carbsPer100g: 20,
        fatPer100g: 6, portionGrams: 100 }],
    }));

    expect(cards).toHaveLength(1);
    expect(cards[0].fitsTarget).toBe(true);
    expect(cards[0].fitNote).toBeNull();
  });

  // Acceptance 4: vetoing every candidate is "vetoing too much" (removing them all would leave
  // 0, well under 3) — Jev's influence is discarded for the whole run, so the formula order
  // stands and no card shows a Jev label at all, in shadow or live.
  it("keeps policy-clean cards in formula order when Jev rejects every one of them", async () => {
    const rejectAll = async (_state: unknown, questions: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(questions).map((key) => [key, answer(0)]));
    const snack = await suggestOptions({ kind: "snack", count: 3 }, fixture({ jev: rejectAll }));
    expect(snack.length).toBeGreaterThanOrEqual(3);
    expect(snack.every((card) => card.rankNote?.startsWith("fits") && !card.rankNote.includes("not a"))).toBe(true);
    const meal = await suggestOptions({ kind: "meal", count: 3 }, fixture({ jev: rejectAll }));
    expect(meal.length).toBeGreaterThanOrEqual(3);
    expect(meal.every((card) => card.rankNote?.startsWith("fits") && !card.rankNote.includes("not a"))).toBe(true);
  });

  // 2026-10-02 DeepSeek audit (MED, finding #3): every candidate blocked by the account's own
  // avoid list (not unverified, not requiring preparation) fell through to a bare `return []` with
  // no `.message` at all — the one silent path left once the unverified/preparation/Jev-rejected
  // branches each already say why.
  it("says why when every candidate is blocked, instead of a bare empty list", async () => {
    const base = fixture();
    const ports: SuggestPorts = {
      ...base,
      suggestionEvidence: async (_userId, items) => ({
        status: "ready", preferenceFlags: [],
        byIdentity: Object.fromEntries(items.map((item) => [suggestionFoodIdentity(item), {
          allergenTags: [], checkedAllergens: ["gluten", "dairy", "apple"], policyCategories: [],
          noCook: null, onEatsList: false, onAvoidList: true, role: "protein" as const,
          facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } },
        }])),
      }),
    };
    const meal = await suggestOptions({ kind: "meal", count: 3 }, ports);
    expect([...meal]).toEqual([]);
    expect(meal.message).toBe(NO_MEAL_FIT_MESSAGE);
  });

  it("drops a Jev-rejected fourth candidate below a fit-equal candidate, once live", () => withVetoLive(async () => {
    const cards = await suggestOptions({ kind: "snack", count: 5 }, fixture({
      jev: async (_state, questions) => Object.fromEntries(Object.keys(questions).map((key) =>
        [key, answer(key === "plausible_3" ? 0 : 2)])),
    }));

    expect(cards.map((card) => card.anchorProtein)).not.toContain("Protein 4");
    expect(cards.at(-1)?.rankNote).toContain("natural snack");
    // C8: Jev ranked every card here, so each says so.
    expect(cards.every((card) => card.provenance?.ai === true && card.provenance.source === "jev")).toBe(true);
    expect(cards[0].provenance).toEqual({ ai: true, source: "jev", purpose: "suggest-options" });
  }));

  it("ranks by macro fit multiplied by normalized plausibility", async () => {
    const suggestModule = await import("@/lib/coach/suggest") as typeof import("@/lib/coach/suggest") & {
      suggestionRank?: (fit: number, score: number | undefined) => number;
    };

    expect(suggestModule.suggestionRank).toBeTypeOf("function");
    if (!suggestModule.suggestionRank) return;
    expect(suggestModule.suggestionRank(0.8, 1.5)).toBeCloseTo(0.6);
    expect(suggestModule.suggestionRank(0.8, undefined)).toBe(0.8);
  });

  it("drops sub-0.50 plausibility only when Jev is at least 0.60 confident, once live", () => withVetoLive(async () => {
    const lowPlausibility = (confidence: number) => async (_state: unknown,
      questions: Record<string, unknown>) => Object.fromEntries(Object.keys(questions).map((key) => [
      key, { ...answer(key === "plausible_0" ? 0.8 : 2), confidence },
    ]));

    const confident = await suggestOptions({ kind: "meal", count: 5 }, fixture({
      jev: lowPlausibility(0.6),
    }));
    const unsure = await suggestOptions({ kind: "meal", count: 5 }, fixture({
      jev: lowPlausibility(0.59),
    }));

    expect(confident.map((card) => card.anchorProtein)).not.toContain("Protein 1");
    expect(unsure.map((card) => card.anchorProtein)).toContain("Protein 1");
  }));

  // 2026-10-03: one card per anchor family (lib/coach/meal-pairings.ts familyKey), so two refs
  // both labelled "Chicken" are one choice now; the same ref under another label stays deduped.
  it("dedupes anchors by food ref and by family, never offering one food twice", async () => {
    const first = { ...protein(1), name: "Chicken" };
    const sameLabelDifferentRef = { ...protein(2), name: "Chicken" };
    const sameRefDifferentLabel = { ...protein(1), name: "Chicken breast" };
    const ports = fixture({ proteins: [first] });
    ports.eatsNames = async () => ["Chicken", "Chicken breast"];
    ports.searchFoods = vi.fn(async (_userId, query) => query === "Chicken"
      ? [first, sameLabelDifferentRef]
      : [sameRefDifferentLabel]);

    const cards = await suggestOptions({ kind: "meal", count: 5 }, ports);

    expect(cards.filter((card) => card.anchorProtein === "Chicken")).toHaveLength(1);
    expect(cards.some((card) => card.anchorProtein === "Chicken breast")).toBe(false);
  });

  it("falls back to deterministic fit order when Jev is unavailable", async () => {
    const proteins = [240, 245, 250, 255, 260, 265].map((kcal, index) => protein(index + 1, kcal));
    const cards = await suggestOptions({ kind: "meal", count: 5 }, fixture({
      proteins,
      jev: async () => null,
    }));

    expect(cards.map((card) => card.anchorProtein)).toEqual([
      "Protein 1", "Protein 2", "Protein 3", "Protein 4", "Protein 5",
    ]);
    expect(cards.every((card) => card.rankNote?.match(/^fits \d+ %$/))).toBe(true);
    // C8: with no Jev answer the order is the app's own fit order, not AI.
    expect(cards.every((card) => card.provenance?.ai === false && card.provenance.source === "app"))
      .toBe(true);
  });

  it("returns the one available protein and says how many options fit", async () => {
    const cards = await suggestOptions({ kind: "recipe", count: 5 }, fixture({
      proteins: [protein(1)],
    }));

    expect(cards).toHaveLength(1);
    expect(cards[0].shortfallNote).toBe("1 of 5 fit your remaining macros");
  });

  it("admits only kcal-close candidates with no macro more than 25 percent over", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 5 }, fixture({
      proteins: [protein(1), protein(2, 313), protein(3), protein(4, 313), protein(5)],
    }));

    expect(cards.map((card) => card.anchorProtein)).toEqual(["Protein 1", "Protein 3", "Protein 5"]);
    expect(cards[0].shortfallNote).toBe("3 of 5 fit your remaining macros");
  });

  it("sizes fit-remaining meals near the 600 kcal next slot, not the 1400 kcal day remainder", async () => {
    const nextSlot = { kcal: 600, protein: 60, carbs: 60, fat: 9.6 };
    const cards = await suggestOptions({ kind: "meal", count: 5, fitRemaining: true },
      fixture({ target: nextSlot }));

    expect(cards).toHaveLength(5);
    expect(cards.every((card) => card.target.kcal === 600)).toBe(true);
    expect(cards.every((card) => Math.abs(card.totals.kcal - 600) <= 90)).toBe(true);
    expect(cards.every((card) => card.totals.kcal < 1400)).toBe(true);
  });

  it("never returns a card containing a policy-blocked item", async () => {
    const blocked = { ...protein(1), name: "Wheat protein", allergenTags: ["gluten"] };
    const cards = await suggestOptions({ kind: "meal", count: 5 }, fixture({
      proteins: [blocked, ...Array.from({ length: 5 }, (_, index) => protein(index + 2))],
    }));

    expect(cards.flatMap((card) => card.items).map((item) => item.name)).not.toContain("Wheat protein");
    expect(cards.every((card) => card.flagged.length === 0)).toBe(true);
  });
});

describe("composed result collection", () => {
  it("keeps one compose_meal card and every suggest_options card in the reply list", () => {
    const one = { wish: "one" } as never;
    const two = [{ wish: "two" }, { wish: "three" }] as never;

    expect(collectComposed([], "compose_meal", one)).toEqual([one]);
    expect(collectComposed([one], "suggest_options", two)).toEqual([one, ...two]);
  });
});
