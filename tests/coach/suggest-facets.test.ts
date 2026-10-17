import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const moduleSpies = vi.hoisted(() => ({
  adminFrom: vi.fn(),
  ensureFacets: vi.fn(),
  providerSystemOne: vi.fn(async () => null),
  readFacets: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/ai/typesafe", () => ({
  score: (instructions: string, criteria: readonly string[]) => ({
    type: "score", instructions, criteria,
  }),
  systemOne: moduleSpies.providerSystemOne,
}));

vi.mock("@/lib/server/admin", () => ({
  adminClient: () => ({ from: moduleSpies.adminFrom }),
}));

vi.mock("@/lib/foods/facets", async (original) => ({
  ...(await original<typeof import("@/lib/foods/facets")>()),
  readFacets: moduleSpies.readFacets,
}));

vi.mock("@/lib/foods/facet-warm", () => ({
  ensureFacets: moduleSpies.ensureFacets,
}));

import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import {
  filterSuggestionCandidates, suggestionFoodIdentity,
  type SuggestionEvidence, type SuggestionFoodEvidence,
} from "@/lib/coach/suggest-policy";
import type { SuggestionCandidate } from "@/lib/coach/suggest-candidates";
import type { ComposedItem } from "@/lib/coach/compose";
import type { FoodHit } from "@/lib/coach/executors";
import { catalogWarmFood } from "@/lib/foods/catalog-ingredients";
import { facetCacheKey, type FacetCacheKey, type FoodFacetJudgments }
  from "@/lib/foods/facets";
import { foodKey, inputHash } from "@/lib/foods/facet-keys";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const TARGET = { kcal: 480, protein: 50, carbs: 50, fat: 8 };
const JUDGED_AT = "2026-09-20T00:00:00Z";
const CHECKED = ["gluten", "dairy", "apple"]; // §5: checked on every label unless a case says not.

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
    allergenTags: [],
    checkedAllergens: CHECKED,
    category: [],
    portionGrams: 120,
  };
}

function judgment(p: number) {
  return { p, rubricVersion: 1, judgedAt: JUDGED_AT };
}

function facts(
  facets: FoodFacetJudgments = { human_food: judgment(1) },
  noCook: boolean | null = null,
  membership: { eats?: boolean; avoid?: boolean } = { eats: true },
): SuggestionFoodEvidence {
  return {
    allergenTags: [], checkedAllergens: CHECKED, policyCategories: [], facets, noCook,
    onEatsList: membership.eats === true,
    onAvoidList: membership.avoid === true,
    role: "protein",
  };
}

function answer(score = 2) {
  return {
    type: "score" as const,
    score,
    legend: { "0": "not", "1": "acceptable", "2": "natural" },
    probabilities: { "0": 0, "1": 0, "2": 1 },
    confidence: 1,
  };
}

function fixture(
  foods: FoodHit[],
  evidenceFor: (name: string) => SuggestionFoodEvidence,
  flags: PolicyPreferenceFlag[] = [],
) {
  const byName = new Map(foods.map((food) => [food.name.toLowerCase(), food]));
  const rank = vi.fn(async (_state: unknown, questions: Record<string, unknown>,
    _options?: { purpose?: string; userId?: string; deadlineMs?: number }) =>
    Object.fromEntries(Object.keys(questions).map((key) => [key, answer()])));
  const ports: SuggestPorts = {
    userId: "u1",
    profile: DEFAULT_PROFILE,
    target: async () => TARGET,
    eatsNames: async () => foods.map((food) => food.name),
    searchFoods: async (_userId, query) => {
      const hit = byName.get(query.toLowerCase());
      return hit ? [hit] : [];
    },
    pendingSlots: async () => [{ slot: "meal-2", label: "Meal 2" }],
    suggestionEvidence: async (_userId, items): Promise<SuggestionEvidence> => ({
      status: "ready",
      preferenceFlags: flags,
      byIdentity: Object.fromEntries(items.map((item) =>
        [suggestionFoodIdentity(item), evidenceFor(item.name)])),
    }),
    // R3: the port takes the builder's payload; the spy keeps its state/questions view.
    systemOne: (p, o) => rank(p.state, p.questions, { ...o, purpose: p.purpose }),
  };
  return { ports, rank };
}

function candidate(items: ComposedItem[]): SuggestionCandidate {
  return {
    index: 0,
    fit: 1,
    meal: {
      wish: "mixed meal", slot: null, items, totals: TARGET, target: TARGET,
      flagged: [], fitsTarget: true,
    },
  };
}

function composed(food: FoodHit): ComposedItem {
  return {
    name: food.name,
    foodRefId: food.foodRefId as string,
    catalogFoodRevisionId: food.catalogFoodRevisionId ?? null,
    grams: 100,
    kcalPer100g: food.kcalPer100g,
    proteinPer100g: food.proteinPer100g ?? null,
    carbsPer100g: food.carbsPer100g ?? null,
    fatPer100g: food.fatPer100g ?? null,
    macros: TARGET,
    verdict: "allowed",
  };
}

function stubAdmin(tables: Record<string, { data: unknown; error: unknown }>) {
  moduleSpies.adminFrom.mockImplementation((table: string) => {
    const response = tables[table] ?? { data: [], error: null };
    const query = {
      eq: vi.fn(), in: vi.fn(), order: vi.fn(), range: vi.fn(),
      maybeSingle: vi.fn(async () => response),
      then: (resolve: (value: typeof response) => unknown,
        reject: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
    };
    for (const name of ["eq", "in", "order", "range"] as const) query[name].mockReturnValue(query);
    return { select: vi.fn(() => query) };
  });
}

beforeEach(() => {
  moduleSpies.adminFrom.mockReset();
  moduleSpies.ensureFacets.mockReset();
  moduleSpies.providerSystemOne.mockReset().mockResolvedValue(null);
  moduleSpies.readFacets.mockReset();
});

describe("suggestion facet gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("removes blocked and applicable unknown candidates before the single ranking call", async () => {
    const foods = [protein(1), protein(2), protein(3)];
    // W2c: names decide; the Jev facets are inverted to prove they no longer block or clear.
    // Protein 1 is chicken (blocked), Protein 2 eggs (class clears), Protein 3 has no evidence.
    const { ports, rank } = fixture(foods, (name) => {
      const meat = name === "Protein 1" ? judgment(0) : name === "Protein 2" ? judgment(1) : undefined;
      const foodName = { "Protein 1": "chicken breast", "Protein 2": "eggs" }[name];
      return { ...facts({ human_food: judgment(1), ...(meat ? { meat } : {}),
        fish_seafood: judgment(0), shellfish: judgment(0) }), ...(foodName ? { foodName } : {}) };
    }, ["vegetarian"]);

    const cards = await suggestOptions({
      kind: "meal", count: 3, slot: "meal-2", wish: "something crisp",
    }, ports);

    // W10b: the one survivor is under the 5-plate shortlist floor (D9 item 4 / acceptance 2),
    // so Jev is never called at all — formula order alone still excludes the blocked and the
    // unverified candidate. The payload-content check this used to make here is covered by
    // "serializes only the current wish..." below, padded past the floor.
    expect(cards.map((card) => card.anchorProtein)).toEqual(["Protein 2"]);
    expect(rank).not.toHaveBeenCalled();
  });

  it("serializes only the current wish, slot, candidate foods, and code-owned macros", async () => {
    // W10b: at least 5 admitted candidates, the shortlist floor (D9 item 4 / acceptance 2), so
    // Jev is actually called here.
    // OD12: an uncleared wish reaches Jev only when attested (tests/ai/jev-health-gate.test.ts).
    vi.stubEnv("JEV_HEALTH_ATTESTED", "1");
    const { ports, rank } = fixture(
      [protein(1), protein(2), protein(3), protein(4), protein(5)], () => facts(),
    );
    const cards = await suggestOptions({
      kind: "meal", count: 1, slot: "meal-2", wish: "current-wish-canary",
    }, ports);

    expect(cards).toHaveLength(1);
    expect(rank).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(rank.mock.calls[0][0]);
    expect(serialized).toContain("current-wish-canary");
    for (const forbidden of ["diet_prefs", "stored-flag-canary", "stored-text-canary",
      "preferenceFlags", "timeOfDay"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns the preparation fallback without ranking when every no-cook option needs prep",
    async () => {
      const { ports, rank } = fixture([protein(1), protein(2)], () => facts(undefined, false));

      const cards = await suggestOptions({ kind: "meal", count: 2, wish: "no-cook please" }, ports);

      expect(cards).toHaveLength(0);
      expect(rank).not.toHaveBeenCalled();
      expect(JSON.parse(JSON.stringify(cards))).toEqual({
        cards: [],
        message: "Every verified option I found needs preparation, so I don't have an honest no-cook option yet.",
      });
    });

  it("returns the preparation fallback when every verified option needs prep", async () => {
    const { ports, rank } = fixture([protein(1), protein(2)], (name) => name === "Protein 1"
      ? facts(undefined, false) : facts({}));

    const cards = await suggestOptions({ kind: "meal", count: 2, wish: "no-cook please" }, ports);

    expect(cards).toHaveLength(0);
    expect(rank).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(cards))).toMatchObject({
      message: "Every verified option I found needs preparation, so I don't have an honest no-cook option yet.",
    });
  });

  it("withholds an unknown no-cook facet as unverified instead of ranking it", async () => {
    const { ports, rank } = fixture([protein(1)], () => facts());

    const cards = await suggestOptions({ kind: "meal", count: 1, wish: "ready to eat" }, ports);

    expect(cards).toEqual([]);
    expect(rank).not.toHaveBeenCalled();
  });

  it("uses the preparation facet only when stored no-cook evidence is absent", async () => {
    const facets = { human_food: judgment(1), requires_preparation: judgment(1) };
    const cachedOnly = fixture([protein(1)], () => facts(facets));
    const storedOverride = fixture([protein(1)], () => facts(facets, true));

    const blocked = await suggestOptions({ kind: "meal", count: 1, wish: "no cooking" },
      cachedOnly.ports);
    const allowed = await suggestOptions({ kind: "meal", count: 1, wish: "no cooking" },
      storedOverride.ports);

    expect(blocked).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(blocked)).message).toContain("needs preparation");
    expect(cachedOnly.rank).not.toHaveBeenCalled();
    expect(allowed).toHaveLength(1);
    // W10b: one survivor is under the 5-plate shortlist floor, so Jev is never called.
    expect(storedOverride.rank).not.toHaveBeenCalled();
  });

  it("withholds an unknown human-food facet before ranking", async () => {
    const { ports, rank } = fixture([protein(1)], () => facts({}));

    const cards = await suggestOptions({ kind: "meal", count: 1 }, ports);

    expect(cards).toEqual([]);
    expect(rank).not.toHaveBeenCalled();
  });

  it("removes an Avoid-list complement before ranking or card selection", () => {
    const anchor = protein(1);
    const complement = { ...protein(2), name: "Avoided complement", catalogFoodRevisionId: null };
    const meal = candidate([composed(anchor), composed(complement)]);
    const evidence: SuggestionEvidence = {
      status: "ready",
      preferenceFlags: [],
      byIdentity: {
        [suggestionFoodIdentity(meal.meal.items[0])]: facts(),
        [suggestionFoodIdentity(meal.meal.items[1])]: facts(undefined, null, { avoid: true }),
      },
    };

    const filtered = filterSuggestionCandidates([meal], evidence, DEFAULT_PROFILE, false);

    expect(filtered.candidates).toEqual([]);
    expect(filtered.blocked).toBe(1);
  });

  it("keeps a mixed Eats and catalog meal when its loaded ingredients are empty", () => {
    const catalog = protein(1);
    const userFood = { ...protein(2), name: "User food", catalogFoodRevisionId: null };
    const meal = candidate([composed(catalog), composed(userFood)]);
    const evidence: SuggestionEvidence = {
      status: "ready",
      preferenceFlags: [],
      byIdentity: {
        [suggestionFoodIdentity(meal.meal.items[0])]: facts(undefined, null, {}),
        [suggestionFoodIdentity(meal.meal.items[1])]: facts(),
      },
    };

    const filtered = filterSuggestionCandidates([meal], evidence, DEFAULT_PROFILE, false);

    expect(filtered.candidates).toEqual([meal]);
  });

  it("withholds unavailable default-loader evidence without ranking or provider warming",
    async () => {
      stubAdmin({ user_settings: { data: null, error: { message: "offline" } } });
      const { ports, rank } = fixture([protein(1)], () => facts());
      delete ports.suggestionEvidence;

      const cards = await suggestOptions({ kind: "meal", count: 1 }, ports);

      expect(cards).toEqual([]);
      expect(rank).not.toHaveBeenCalled();
      expect(moduleSpies.ensureFacets).not.toHaveBeenCalled();
      expect(moduleSpies.providerSystemOne).not.toHaveBeenCalled();
    });

  it("loads catalog and user-food cache keys together and ranks both cache hits", async () => {
    const catalog = protein(1);
    const userFood = { ...protein(2), name: "User protein", catalogFoodRevisionId: null };
    const catalogRow = {
      id: 1, description: catalog.name, brand: null, category: "prepared food",
      policy_categories: [], prep_state: "cooked",
      catalog_ingredients: [], catalog_portions: [],
    };
    const userRow = {
      id: "user-food-2", user_id: "u1", name: userFood.name, brand: null,
      ingredients_text: null, allergen_tags: [], rev: 4,
    };
    stubAdmin({
      user_settings: { data: { diet_prefs: { flags: [] } }, error: null },
      user_food_prefs: { data: [
        { food_ref_id: catalog.foodRefId, status: "eats", role: "protein", no_cook: false },
        { food_ref_id: userFood.foodRefId, status: "eats", role: "protein", no_cook: false },
      ], error: null },
      catalog_food_revisions: { data: [catalogRow], error: null },
      food_refs: { data: [
        { id: catalog.foodRefId, kind: "catalog", user_food_id: null, user_foods: null },
        { id: userFood.foodRefId, kind: "user", user_food_id: userRow.id,
          user_foods: userRow },
      ], error: null },
      // Phase 13 §5: this user checked both labels for every allergen the fixture avoids.
      user_allergen_checks: { data: ["catalog_revision:1", "user_food:user-food-2:4"]
        .flatMap((food_key) => CHECKED.map((allergen) => ({ food_key, allergen }))), error: null },
    });
    moduleSpies.readFacets.mockImplementation(async (keys: FacetCacheKey[]) => Object.assign(
      new Map(keys.map((key) => [facetCacheKey(key), { human_food: judgment(1) }])),
      { errors: 0 },
    ));
    const { ports, rank } = fixture([catalog, userFood], () => facts());
    delete ports.suggestionEvidence;

    const cards = await suggestOptions({ kind: "meal", count: 2 }, ports);

    expect(cards.map((card) => card.anchorProtein)).toEqual([catalog.name, userFood.name]);
    // W10b: 2 survivors is under the 5-plate shortlist floor, so Jev is never called.
    expect(rank).not.toHaveBeenCalled();
    expect(moduleSpies.readFacets).toHaveBeenCalledOnce();
    const warm = catalogWarmFood(catalogRow);
    const expectedCatalog = {
      foodKey: foodKey(warm.identity),
      inputHash: inputHash({
        name: warm.name, brand: warm.brand, description: warm.category,
        preparation: warm.serving, ingredientsText: warm.ingredientsText,
      }),
    };
    const expectedUser = {
      foodKey: foodKey({ kind: "user_food", id: userRow.id, rev: userRow.rev }),
      inputHash: inputHash({
        name: userRow.name, brand: userRow.brand, ingredientsText: userRow.ingredients_text,
      }),
    };
    expect(moduleSpies.readFacets.mock.calls[0][0]).toEqual([expectedCatalog, expectedUser]);
    expect(moduleSpies.readFacets.mock.calls[0][0].map(facetCacheKey)).toEqual([
      facetCacheKey(expectedCatalog), facetCacheKey(expectedUser),
    ]);
    expect(moduleSpies.ensureFacets).not.toHaveBeenCalled();
    expect(moduleSpies.providerSystemOne).not.toHaveBeenCalled();
  });
});
