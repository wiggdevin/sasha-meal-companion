import { beforeEach, describe, expect, it, vi } from "vitest";

const moduleSpies = vi.hoisted(() => ({
  adminFrom: vi.fn(),
  readFacets: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/admin", () => ({
  adminClient: () => ({ from: moduleSpies.adminFrom }),
}));

vi.mock("@/lib/foods/facets", async (original) => ({
  ...(await original<typeof import("@/lib/foods/facets")>()),
  readFacets: moduleSpies.readFacets,
}));

import {
  filterSuggestionCandidates,
  loadSuggestionEvidence,
  suggestionFoodIdentity,
  type SuggestionEvidence,
  type SuggestionFoodEvidence,
} from "@/lib/coach/suggest-policy";
import type { SuggestionCandidate } from "@/lib/coach/suggest-candidates";
import type { ComposedItem } from "@/lib/coach/compose";
import { facetCacheKey, type FacetCacheKey, type FoodFacetJudgments } from "@/lib/foods/facets";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { starterFood } from "@/lib/foods/starter";
import { uuidV5 } from "@/lib/foods/uuid5";
import { perUnitTo100g } from "@/lib/units";
import { accountUnitGrams } from "@/lib/foods/unit-grams";

const TARGET = { kcal: 480, protein: 50, carbs: 50, fat: 8 };
const JUDGED_AT = "2026-09-20T00:00:00Z";

function judgment(p: number) {
  return { p, rubricVersion: 1, judgedAt: JUDGED_AT };
}

function item(index: number, name: string, catalogFoodRevisionId: number | null = index) {
  return {
    name,
    foodRefId: `3f1b1a2c-0000-4000-8000-00000000000${index}`,
    catalogFoodRevisionId,
    grams: 100,
    kcalPer100g: 240,
    proteinPer100g: 25,
    carbsPer100g: 25,
    fatPer100g: 4,
    macros: TARGET,
    verdict: "allowed" as const,
  } satisfies ComposedItem;
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

function facts(options: {
  human?: number;
  noCook?: boolean | null;
  avoid?: boolean;
} = {}): SuggestionFoodEvidence {
  return {
    allergenTags: [],
    // Phase 13 §5: the fixture's allergens are cleared (labels checked) unless a case says not.
    checkedAllergens: ["gluten", "dairy", "apple"],
    policyCategories: [],
    facets: options.human === undefined ? {} : { human_food: judgment(options.human) },
    noCook: options.noCook ?? null,
    onEatsList: !options.avoid,
    onAvoidList: options.avoid === true,
    role: "protein",
  };
}

function evidenceFor(
  items: readonly ComposedItem[],
  factsByIndex: readonly SuggestionFoodEvidence[],
): SuggestionEvidence {
  return {
    status: "ready",
    preferenceFlags: [],
    byIdentity: Object.fromEntries(items.map((food, index) =>
      [suggestionFoodIdentity(food), factsByIndex[index]])),
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
  moduleSpies.readFacets.mockReset();
});

describe("suggestion candidate policy precedence", () => {
  it("counts prep present plus a blocked complement as blocked", () => {
    const items = [item(1, "Prep"), item(2, "Avoided complement")];
    const result = filterSuggestionCandidates(
      [candidate(items)],
      evidenceFor(items, [facts({ human: 1, noCook: false }),
        facts({ human: 1, noCook: true, avoid: true })]),
      DEFAULT_PROFILE,
      true,
    );

    expect(result).toMatchObject({
      candidates: [], blocked: 1, unverified: 0, requiresPreparation: 0,
    });
  });

  it("counts prep present plus an unverified complement as unverified", () => {
    const items = [item(1, "Prep"), item(2, "Unknown complement")];
    const result = filterSuggestionCandidates(
      [candidate(items)],
      evidenceFor(items, [facts({ human: 1, noCook: false }), facts({ noCook: true })]),
      DEFAULT_PROFILE,
      true,
    );

    expect(result).toMatchObject({
      candidates: [], blocked: 0, unverified: 1, requiresPreparation: 0,
    });
  });

  it("does not treat no-cook false as verified prep for unknown human food", () => {
    const items = [item(1, "Unknown food")];
    const result = filterSuggestionCandidates(
      [candidate(items)], evidenceFor(items, [facts({ noCook: false })]), DEFAULT_PROFILE, true,
    );

    expect(result).toMatchObject({
      candidates: [], blocked: 0, unverified: 1, requiresPreparation: 0,
    });
  });

  it("requires preparation after every item is verified and allowed", () => {
    const items = [item(1, "Prep"), item(2, "Ready complement")];
    const result = filterSuggestionCandidates(
      [candidate(items)],
      evidenceFor(items, [facts({ human: 1, noCook: false }),
        facts({ human: 1, noCook: true })]),
      DEFAULT_PROFILE,
      true,
    );

    expect(result).toMatchObject({
      candidates: [], blocked: 0, unverified: 0, requiresPreparation: 1,
    });
  });
});

describe("suggestion category evidence", () => {
  it("withholds a user food without authored categories under low FODMAP", async () => {
    const food = item(2, "User protein", null);
    const userRow = {
      id: "user-food-2", user_id: "u1", name: food.name, brand: null,
      ingredients_text: null, allergen_tags: [], rev: 4,
    };
    stubAdmin({
      user_settings: { data: { diet_prefs: { flags: ["low_fodmap"] } }, error: null },
      user_food_prefs: { data: [
        { food_ref_id: food.foodRefId, status: "eats", role: "protein", no_cook: true },
      ], error: null },
      catalog_food_revisions: { data: [], error: null },
      food_refs: { data: [
        { id: food.foodRefId, kind: "user", user_food_id: userRow.id, user_foods: userRow },
      ], error: null },
    });
    moduleSpies.readFacets.mockImplementation(async (keys: FacetCacheKey[]) => Object.assign(
      new Map(keys.map((key) => [facetCacheKey(key), { human_food: judgment(1) }])),
      { errors: 0 },
    ));

    const evidence = await loadSuggestionEvidence("u1", [food], { needsNoCook: false });
    const result = filterSuggestionCandidates(
      [candidate([food])], evidence, DEFAULT_PROFILE, false,
    );

    expect(evidence.byIdentity[suggestionFoodIdentity(food)]).toMatchObject({
      allergenTags: [], policyCategories: null,
    });
    expect(result).toMatchObject({
      candidates: [], blocked: 0, unverified: 1, requiresPreparation: 0,
    });
  });

  it("keeps a catalog food whose loaded category relation is empty", async () => {
    const food = item(1, "Catalog protein");
    const row = {
      id: 1, description: food.name, brand: null, category: "prepared food",
      policy_categories: [], prep_state: "cooked",
      catalog_ingredients: [], catalog_portions: [],
    };
    stubAdmin({
      user_settings: { data: { diet_prefs: { flags: [] } }, error: null },
      user_food_prefs: { data: [
        { food_ref_id: food.foodRefId, status: "eats", role: "protein", no_cook: true },
      ], error: null },
      catalog_food_revisions: { data: [row], error: null },
      food_refs: { data: [], error: null },
      // Phase 13 §5: the user checked this product's label for every allergen the fixture avoids.
      user_allergen_checks: { data: ["gluten", "dairy", "apple"].map((allergen) =>
        ({ food_key: "catalog_revision:1", allergen })), error: null },
    });
    moduleSpies.readFacets.mockImplementation(async (keys: FacetCacheKey[]) => Object.assign(
      new Map(keys.map((key) => [facetCacheKey(key), { human_food: judgment(1) }])),
      { errors: 0 },
    ));

    const evidence = await loadSuggestionEvidence("u1", [food], { needsNoCook: false });
    const result = filterSuggestionCandidates(
      [candidate([food])], evidence, DEFAULT_PROFILE, false,
    );

    expect(evidence.byIdentity[suggestionFoodIdentity(food)]?.policyCategories).toEqual([]);
    expect(result.candidates).toEqual([candidate([food])]);
  });
});

describe("account-owned bundled starter evidence", () => {
  async function starterRow(id: string) {
    const food = starterFood(id, "eats");
    // The membership writer's own resolver (starter first): whey has no generic cup conversion.
    const grams = accountUnitGrams(food);
    if (grams === null) throw new Error(`No portion for ${id}`);
    return { id: await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      `legacy-food:u1:${food.id}`), user_id: "u1", kind: "custom",
    name: food.name, brand: null, ingredients_text: null, allergen_tags: [],
    catalog_food_id: null, deleted_at: null, per_100g: perUnitTo100g(food.perUnit, grams), rev: 1 };
  }

  async function evidenceForStarter(id: string, mutate: Record<string, unknown> = {},
    flags: string[] = [], cachedFacets: FoodFacetJudgments = {}) {
    const food = item(3, id, null);
    const row = { ...await starterRow(id), ...mutate };
    stubAdmin({
      user_settings: { data: { diet_prefs: { flags } }, error: null },
      user_food_prefs: { data: [{ food_ref_id: food.foodRefId, status: "eats",
        role: "protein", no_cook: null }], error: null },
      food_refs: { data: [{ id: food.foodRefId, kind: "user", user_food_id: row.id,
        user_foods: row }], error: null },
    });
    moduleSpies.readFacets.mockImplementation(async (keys: FacetCacheKey[]) => Object.assign(
      new Map(keys.map((key) => [facetCacheKey(key), cachedFacets])), { errors: 0 }));
    return { food, evidence: await loadSuggestionEvidence("u1", [food], { needsNoCook: false }) };
  }

  it("lets the same canonical coach gate recognize a verified vegan starter", async () => {
    const { food, evidence } = await evidenceForStarter("tofu-firm", {}, ["vegan"]);
    expect(evidence.byIdentity[suggestionFoodIdentity(food)]?.facets).toMatchObject({
      human_food: { p: 1 }, animal_product: { p: 0 }, meat: { p: 0 },
    });
    expect(filterSuggestionCandidates([candidate([food])], evidence, EMPTY_PROFILE, false)
      .candidates).toHaveLength(1);
  });

  it.each([
    ["omnivore", "chicken-breast-roasted"],
    ["pescatarian", "salmon-wild-sockeye-cooked"],
    ["vegetarian", "egg-white"],
    ["vegan", "tofu-firm"],
  ])("permits an attested %s protein through the canonical gate", async (diet, starterId) => {
    const { food, evidence } = await evidenceForStarter(starterId,
      {}, diet === "omnivore" ? [] : [diet]);
    expect(filterSuggestionCandidates([candidate([food])], evidence, EMPTY_PROFILE, false)
      .candidates).toHaveLength(1);
  });

  it("keeps an edited starter and unresolved allergen out of suggestions", async () => {
    // An edited starter loses its attested facets. Plain tofu would still pass the human-food gate
    // by its own name (2026-10-02), so the edited row here is one whose name is not a whole food.
    const changed = await evidenceForStarter("corn-tortilla", { per_100g: { protein: 999 } });
    expect(filterSuggestionCandidates([candidate([changed.food])], changed.evidence,
      EMPTY_PROFILE, false).candidates).toEqual([]);
    // A prepared food: plain tofu now clears dairy as a whole food (2026-10-02), a tortilla cannot.
    const unknown = await evidenceForStarter("corn-tortilla");
    expect(filterSuggestionCandidates([candidate([unknown.food])], unknown.evidence,
      { ...EMPTY_PROFILE, avoid_allergens: ["dairy"] }, false).candidates).toEqual([]);
    const positive = await evidenceForStarter("tofu-firm");
    expect(filterSuggestionCandidates([candidate([positive.food])], positive.evidence,
      { ...EMPTY_PROFILE, avoid_allergens: ["soy"] }, false).blocked).toBe(1);
    const category = await evidenceForStarter("chicken-breast-roasted");
    expect(filterSuggestionCandidates([candidate([category.food])], category.evidence,
      { ...EMPTY_PROFILE, banned_categories: ["poultry"] }, false).blocked).toBe(1);
  });

  it.each([
    ["vegan", "chicken-breast-roasted", { animal_product: judgment(0), meat: judgment(0) }],
    ["vegetarian", "salmon-wild-sockeye-cooked", { meat: judgment(0), fish_seafood: judgment(0) }],
  ])("blocks attested %s conflict despite stale cached facets", async (diet, id, stale) => {
    const { food, evidence } = await evidenceForStarter(id, {}, [diet], {
      human_food: judgment(1), ...stale,
    });
    expect(filterSuggestionCandidates([candidate([food])], evidence, EMPTY_PROFILE, false)
      .candidates).toEqual([]);
  });

  it("retains a cached non-food verdict; a contrary Jev positive no longer decides (W2c)", async () => {
    // Phase 18 W2c: a cached Jev `animal_product` no longer blocks; the starter's curated evidence
    // and its own name decide, so plain tofu stays a vegan food.
    const disputedTofu = await evidenceForStarter("tofu-firm", {}, ["vegan"], {
      human_food: judgment(1), animal_product: judgment(1),
    });
    expect(filterSuggestionCandidates([candidate([disputedTofu.food])],
      disputedTofu.evidence, EMPTY_PROFILE, false).candidates).toHaveLength(1);
    // A curated positive still blocks: whey is not vegan, whatever a cache says.
    const whey = await evidenceForStarter("whey-protein-powder", {}, ["vegan"], {
      human_food: judgment(1), animal_product: judgment(0),
    });
    const wheyResult = filterSuggestionCandidates([candidate([whey.food])],
      whey.evidence, EMPTY_PROFILE, false);
    expect(wheyResult.candidates).toEqual([]);
    expect(wheyResult.blocked).toBe(1);
    // With no curated evidence at all (an edited row), the name alone still blocks whey.
    const editedWhey = await evidenceForStarter("whey-protein-powder",
      { per_100g: { protein: 999 } }, ["vegan"], { human_food: judgment(1), animal_product: judgment(0) });
    expect(filterSuggestionCandidates([candidate([editedWhey.food])],
      editedWhey.evidence, EMPTY_PROFILE, false).blocked).toBe(1);

    const disputedFood = await evidenceForStarter("tofu-firm", {}, [], {
      human_food: judgment(0),
    });
    expect(filterSuggestionCandidates([candidate([disputedFood.food])],
      disputedFood.evidence, EMPTY_PROFILE, false).candidates).toEqual([]);
  });
});

describe("sol BLOCK (r5): a custom user food's own ingredient text is never a label (§9 R2)",
  () => {
    const DAIRY_ONLY = { ...DEFAULT_PROFILE, avoid_allergens: ["dairy"] };

    function stubUserFood(kind: string) {
      const food = item(3, "User protein", null);
      const userRow = {
        id: "user-food-3", user_id: "u1", name: food.name, brand: null,
        // Complete-looking and terminated; genuinely names no dairy. Only a real printed label
        // (kind "label_scan") may treat that shape as license to clear a major allergen.
        ingredients_text: "Water, sugar, salt.", allergen_tags: [], rev: 1, kind,
      };
      stubAdmin({
        user_settings: { data: { diet_prefs: { flags: [] } }, error: null },
        user_food_prefs: { data: [
          { food_ref_id: food.foodRefId, status: "eats", role: "protein", no_cook: true },
        ], error: null },
        catalog_food_revisions: { data: [], error: null },
        food_refs: { data: [
          { id: food.foodRefId, kind: "user", user_food_id: userRow.id, user_foods: userRow },
        ], error: null },
      });
      moduleSpies.readFacets.mockImplementation(async (keys: FacetCacheKey[]) => Object.assign(
        new Map(keys.map((key) => [facetCacheKey(key), { human_food: judgment(1) }])),
        { errors: 0 },
      ));
      return food;
    }

    it("a client-created custom food's complete-looking text cannot clear dairy on its own",
      async () => {
        const food = stubUserFood("custom");
        const evidence = await loadSuggestionEvidence("u1", [food], { needsNoCook: false });
        expect(evidence.byIdentity[suggestionFoodIdentity(food)]?.ingredientsTextIsLabel)
          .toBe(false);
        const result = filterSuggestionCandidates(
          [candidate([food])], evidence, DAIRY_ONLY, false,
        );
        expect(result).toMatchObject({ candidates: [], unverified: 1 });
      });

    it("a genuinely scanned label's own complete text still clears dairy", async () => {
      const food = stubUserFood("label_scan");
      const evidence = await loadSuggestionEvidence("u1", [food], { needsNoCook: false });
      expect(evidence.byIdentity[suggestionFoodIdentity(food)]?.ingredientsTextIsLabel).toBe(true);
      const result = filterSuggestionCandidates(
        [candidate([food])], evidence, DAIRY_ONLY, false,
      );
      expect(result).toMatchObject({ candidates: [candidate([food])] });
    });
  });

describe("ORCHESTRATOR fix (round 7, item 4): completenessText/raw_text, never " +
  "catalogIngredientsText's lossy join", () => {
  const DAIRY_ONLY = { ...DEFAULT_PROFILE, avoid_allergens: ["dairy"] };

  it("a complete, terminated catalog label is not demoted to unverified by joining seq 1's own " +
    "verbatim text with the later rows' redundant fragments (the join loses the terminator: " +
    "\"Water, rice, salt., rice, salt\" does not end in a period)", async () => {
    const food = item(4, "Catalog protein");
    const row = {
      id: 4, description: food.name, brand: null, category: "prepared food",
      policy_categories: [], prep_state: "cooked",
      catalog_ingredients: [
        { seq: 1, name: "Water", raw_text: "Water, rice, salt.", allergen_tags: [] },
        { seq: 2, name: "rice", raw_text: null, allergen_tags: [] },
        { seq: 3, name: "salt", raw_text: null, allergen_tags: [] },
      ],
      catalog_portions: [],
    };
    stubAdmin({
      user_settings: { data: { diet_prefs: { flags: [] } }, error: null },
      user_food_prefs: { data: [
        { food_ref_id: food.foodRefId, status: "eats", role: "protein", no_cook: true },
      ], error: null },
      catalog_food_revisions: { data: [row], error: null },
      food_refs: { data: [], error: null },
      user_allergen_checks: { data: [], error: null },
    });
    moduleSpies.readFacets.mockImplementation(async (keys: FacetCacheKey[]) => Object.assign(
      new Map(keys.map((key) => [facetCacheKey(key), { human_food: judgment(1) }])),
      { errors: 0 },
    ));

    const evidence = await loadSuggestionEvidence("u1", [food], { needsNoCook: false });
    expect(evidence.byIdentity[suggestionFoodIdentity(food)]).toMatchObject({
      ingredientsText: "Water, rice, salt.", ingredientsTextIsLabel: true,
    });
    const result = filterSuggestionCandidates(
      [candidate([food])], evidence, DAIRY_ONLY, false,
    );
    expect(result).toMatchObject({ candidates: [candidate([food])] });
  });
});

describe("suggestion evidence with a failed facet or label-check read (review round 3)", () => {
  const food = item(1, "Catalog protein");
  const row = {
    id: 1, description: food.name, brand: null, category: "prepared food",
    policy_categories: [], prep_state: "cooked", catalog_ingredients: [], catalog_portions: [],
  };
  const tables = (checks: { data: unknown; error: unknown }) => ({
    user_settings: { data: { diet_prefs: { flags: [] } }, error: null },
    user_food_prefs: { data: [
      { food_ref_id: food.foodRefId, status: "eats", role: "protein", no_cook: true },
    ], error: null },
    catalog_food_revisions: { data: [row], error: null },
    food_refs: { data: [], error: null },
    user_allergen_checks: checks,
  });
  const facetsWith = (errors: number) => moduleSpies.readFacets.mockImplementation(
    async (keys: FacetCacheKey[]) => Object.assign(
      new Map(keys.map((key) => [facetCacheKey(key), { human_food: judgment(1) }])), { errors }));

  it("is unavailable, never ready on partial evidence, when the facet read reports errors", async () => {
    stubAdmin(tables({ data: [], error: null }));
    facetsWith(1);
    const evidence = await loadSuggestionEvidence("u1", [food], { needsNoCook: false });
    expect(evidence).toEqual({ status: "unavailable", preferenceFlags: [], byIdentity: {} });
  });

  it("is unavailable when the label-check query fails", async () => {
    stubAdmin(tables({ data: null, error: { message: "synthetic outage" } }));
    facetsWith(0);
    const evidence = await loadSuggestionEvidence("u1", [food], { needsNoCook: false });
    expect(evidence.status).toBe("unavailable");
  });

  it("stays ready when both reads succeed", async () => {
    stubAdmin(tables({ data: [], error: null }));
    facetsWith(0);
    expect((await loadSuggestionEvidence("u1", [food], { needsNoCook: false })).status).toBe("ready");
  });
});
