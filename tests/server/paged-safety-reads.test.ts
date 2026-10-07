/**
 * t18 (2026-10-05): food-safety reads page past the API's 1,000-row cap, and a failed page fails
 * the whole read. The fake below answers like PostgREST: it filters, orders and slices by
 * `.range()`, an unranged select stops at 1,000 rows, and a configured page answers an error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { recipe } from "../recipes/fixture";

vi.mock("server-only", () => ({}));
const systemOne = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/ai/typesafe", async (original) => ({
  ...(await original<typeof import("@/lib/ai/typesafe")>()), systemOne }));
vi.mock("@/lib/recipe-catalog/repository", () => ({
  getPinnedRecipeRevisions: vi.fn(), searchCatalog: vi.fn(async () => [recipe()]),
  getCatalogRecipe: vi.fn(async () => recipe()),
}));
vi.mock("@/lib/server/constraints", () => ({ getRuleReviewStatus: vi.fn(async () => ({ required: false })) }));
vi.mock("@/lib/server/policy-profile", () => ({
  readPolicyProfile: vi.fn(async () => ({ profile: EMPTY_PROFILE, rev: 1, instances: [] })),
}));
vi.mock("@/lib/server/recipe-pilot-identity", () => ({ resolvePilotCatalogRevisions: vi.fn(async () => new Map()) }));

type Row = Record<string, unknown>;
const CAP = 1000;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  /** table → the `.range()` start offset that answers an error. */
  failFrom: {} as Record<string, number>,
  /** table → every ranged read after this many succeeded answers an error. */
  failAfter: {} as Record<string, number>,
  calls: {} as Record<string, number>,
}));

function fake(): SupabaseClient {
  return { from: (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const orders: string[] = [];
    let range: [number, number] | null = null;
    const answer = () => {
      if (range && table in state.failAfter) {
        state.calls[table] = (state.calls[table] ?? 0) + 1;
        if (state.calls[table] > state.failAfter[table]) {
          return { data: null, error: { message: "synthetic outage" } };
        }
      }
      if (range && state.failFrom[table] === range[0]) {
        return { data: null, error: { message: `synthetic outage at ${range[0]}` } };
      }
      const rows = (state.tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      rows.sort((a, b) => {
        for (const column of orders) {
          const [x, y] = [a[column], b[column]];
          if (x !== y) return (typeof x === "number" && typeof y === "number" ? x < y
            : String(x) < String(y)) ? -1 : 1;
        }
        return 0;
      });
      const [from, to] = range ?? [0, CAP - 1];
      return { data: rows.slice(from, Math.min(to, from + CAP - 1) + 1), error: null };
    };
    const query: Record<string, unknown> = {
      select: () => query, or: () => query, limit: () => query,
      eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
      is: (column: string, value: unknown) => { filters.push((row) => (row[column] ?? null) === value); return query; },
      in: (column: string, values: unknown[]) => {
        const wanted = new Set(values.map(String));
        filters.push((row) => wanted.has(String(row[column])));
        return query;
      },
      order: (column: string) => { orders.push(column); return query; },
      range: (from: number, to: number) => { range = [from, to]; return query; },
      maybeSingle: async () => ({ data: null, error: null }),
      upsert: async () => ({ error: null }),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject),
    };
    return query;
  }, rpc: async () => ({ data: "ref-1", error: null }) } as unknown as SupabaseClient;
}
vi.mock("@/lib/server/admin", () => ({ adminClient: () => fake() }));

const { fetchAllRows, PAGE_SIZE } = await import("@/lib/server/paged-read");
const { readAvoidList } = await import("@/lib/server/avoid-list");
const { readAllergenChecks, readAllergenEvidence } = await import("@/lib/server/allergen-evidence");
const { loadShoppingRuleContext } = await import("@/lib/server/shopping-rule-marks");
const { loadMarkedRecipeDetail, loadRecipeDetail } = await import("@/lib/server/recipe-candidates");
const { evidenceForItems } = await import("@/lib/server/log-evidence");
const { groundItem, labelFoodOf } = await import("@/lib/server/capture");
const { ensureFacets } = await import("@/lib/foods/facet-warm");
const { FACETS, facetRubricVersion } = await import("@/lib/foods/facets");
const { OCCASION_FACETS } = await import("@/lib/foods/facet-vocabulary");
const { inputHash, warmFoodCacheKey } = await import("@/lib/foods/facet-keys");
const { warmEatsFacets } = await import("@/lib/server/eats-facet-warm");
const { eatsForSuggestions } = await import("@/lib/server/coach-context");
const { eligibleFoods } = await import("@/lib/server/eligible-foods");

const USER = "account";
const pad = (n: number) => String(n).padStart(5, "0");

/** `count` avoided user foods, each with its own ref and name. */
function seedAvoid(count: number, extraRefIds: string[] = []): void {
  const ids = Array.from({ length: count }, (_, i) => `aa-${pad(i)}`);
  state.tables.user_food_prefs = [...ids, ...extraRefIds].map((id) =>
    ({ user_id: USER, food_ref_id: id, status: "avoid" }));
  state.tables.food_refs = ids.map((id) =>
    ({ id, kind: "user", catalog_food_id: null, user_food_id: `uf-${id}` }));
  state.tables.user_foods = ids.map((id) => ({ id: `uf-${id}`, user_id: USER, name: `Food ${id}` }));
}

beforeEach(() => {
  systemOne.mockClear();
  state.tables = {};
  state.failFrom = {};
  state.failAfter = {};
  state.calls = {};
});

describe("fetchAllRows", () => {
  it("reads past the cap and fails as a whole when page 2 fails", async () => {
    state.tables.t = Array.from({ length: 2500 }, (_, i) => ({ id: pad(i) }));
    const client = fake();
    const all = await fetchAllRows<Row>((from, to) =>
      client.from("t").select("id").order("id").range(from, to));
    expect(all).toHaveLength(2500);
    expect(new Set(all.map((row) => row.id)).size).toBe(2500);

    state.failFrom.t = PAGE_SIZE;
    await expect(fetchAllRows<Row>((from, to) =>
      client.from("t").select("id").order("id").range(from, to))).rejects.toThrow(/outage/);
  });
});

describe("the Avoid list (lib/server/avoid-list.ts)", () => {
  it("returns every entry past 1,000 rows, with every name", async () => {
    seedAvoid(1500);
    const avoid = await readAvoidList(fake(), USER);
    expect(avoid.refIds).toHaveLength(1500);
    expect(avoid.names).toHaveLength(1500);
    expect(avoid.refIds).toContain("aa-01499");
  });

  it("rejects when page 2 of the prefs fails, never a 1,000-entry list", async () => {
    seedAvoid(1500);
    state.failFrom.user_food_prefs = PAGE_SIZE;
    await expect(readAvoidList(fake(), USER)).rejects.toThrow();
  });

  it("shopping marks: a failed page 2 leaves the Avoid list unread (null), not partial", async () => {
    seedAvoid(1500);
    expect((await loadShoppingRuleContext(fake(), USER, [])).avoid?.refIds.size).toBe(1500);
    state.failFrom.user_food_prefs = PAGE_SIZE;
    expect((await loadShoppingRuleContext(fake(), USER, [])).avoid).toBeNull();
  });
});

describe("the recipe policy's Avoid read (lib/server/recipe-candidates.ts)", () => {
  it("blocks a recipe whose ingredient is the 1,201st Avoid entry", async () => {
    seedAvoid(1200, ["beans"]); // "beans" sorts after every "aa-" ref: it lands on page 2
    const detail = await loadRecipeDetail(fake(), USER, "stew");
    expect(detail?.recipe.eligibility.status).toBe("blocked");
    expect(detail?.recipe.eligibility.reasons.map((r) => r.code)).toContain("avoid_list");
  });

  it("fails closed when page 2 fails: the strict loader rejects, the marked one says unknown", async () => {
    seedAvoid(1200, ["beans"]);
    state.failFrom.user_food_prefs = PAGE_SIZE;
    await expect(loadRecipeDetail(fake(), USER, "stew")).rejects.toMatchObject({ status: 503 });
    const marked = await loadMarkedRecipeDetail(fake(), USER, "stew");
    expect(marked?.rulesFingerprint).toBeNull();
    expect(marked?.recipe.ruleMark).toMatchObject({ verdict: "unknown" });
  });
});

describe("stored allergen evidence and checks (lib/server/allergen-evidence.ts)", () => {
  const ALLERGENS = ["milk", "egg", "peanut", "tree-nut", "soy", "wheat", "fish", "shellfish",
    "sesame", "crustacean"];
  const keys = Array.from({ length: 150 }, (_, i) => `catalog_revision:${pad(i)}`);

  it("reads every evidence row past 1,000 (150 foods × 10 allergens)", async () => {
    state.tables.food_allergen_evidence = keys.flatMap((food_key) => ALLERGENS.map((allergen) =>
      ({ food_key, allergen, level: "listed", label_complete: true })));
    const evidence = await readAllergenEvidence(fake(), keys);
    expect(evidence.size).toBe(150);
    // The last food's last allergen sits on page 2.
    expect(evidence.get(keys[149])?.sesame).toEqual({ level: "listed", labelComplete: true });
    expect([...evidence.values()].every((byAllergen) => Object.keys(byAllergen).length === 10))
      .toBe(true);
  });

  it("throws when page 2 of the evidence fails, never a partial map", async () => {
    state.tables.food_allergen_evidence = keys.flatMap((food_key) => ALLERGENS.map((allergen) =>
      ({ food_key, allergen, level: "listed", label_complete: true })));
    state.failFrom.food_allergen_evidence = PAGE_SIZE;
    await expect(readAllergenEvidence(fake(), keys)).rejects.toThrow();
  });

  it("reads every check past 1,000, and reports failure (empty) when page 2 fails", async () => {
    state.tables.user_allergen_checks = keys.flatMap((food_key) => ALLERGENS.map((allergen) =>
      ({ user_id: USER, food_key, allergen })));
    const checks = await readAllergenChecks(fake(), USER, keys);
    expect(checks.failed).toBe(false);
    expect([...checks.values()].flat()).toHaveLength(1500);

    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.failFrom.user_allergen_checks = PAGE_SIZE;
    const failed = await readAllergenChecks(fake(), USER, keys);
    expect(failed.failed).toBe(true);
    expect(failed.size).toBe(0);
  });
});

describe("ingredient allergen tags on the log commit (lib/server/log-evidence.ts)", () => {
  // 60 pinned revisions × 20 ingredient rows: the last revision's rows sit on page 2.
  const revisions = Array.from({ length: 60 }, (_, i) => 10_000 + i);
  const items = revisions.map((id) => ({ food_ref_id: `ref-${id}`, food_revision_id: id }));
  const seed = () => {
    state.tables.catalog_ingredients = revisions.flatMap((food_revision_id) =>
      Array.from({ length: 20 }, (_, seq) => ({ food_revision_id, seq: 100 + seq,
        allergen_tags: food_revision_id === 10_059 && seq === 19 ? ["sesame"] : [] })));
  };

  it("reads every ingredient row past 1,000", async () => {
    seed();
    const evidence = await evidenceForItems(fake(), items as never, null);
    expect(evidence.at(-1)?.allergenTags).toEqual(["sesame"]);
  });

  it("throws when page 2 fails, never a partial tag map", async () => {
    seed();
    state.failFrom.catalog_ingredients = PAGE_SIZE;
    await expect(evidenceForItems(fake(), items as never, null)).rejects.toThrow();
  });
});

describe("one revision's ingredient rows on a grounded capture (lib/server/capture.ts)", () => {
  // 1,001 ingredient rows on one revision; only the last one names sesame.
  const seed = () => {
    state.tables.catalog_ingredients = Array.from({ length: 1001 }, (_, i) => ({
      food_revision_id: 70, seq: i + 1, name: `Ingredient ${i + 1}`, raw_text: null,
      allergen_tags: i === 1000 ? ["sesame"] : [] }));
  };
  const profile = { avoid_allergens: ["sesame"], avoid_food_ref_ids: [], banned_categories: [] };
  const item = { label: "Trail mix bar", grams: 40, qty: 1, unit: "bar", confidence: 0.9 };
  const searchFoods = async () => ({ hits: [{ catalogFoodId: 7, revisionId: 70,
    description: "Trail mix bar", brand: null, score: 0.95 }], queryClass: "generic" as const,
    catalogVersion: "v1", autoResolve: null });

  it("blocks on a sesame tag in row 1,001", async () => {
    seed();
    const result = await groundItem(fake(), USER, item as never, null, profile as never,
      searchFoods as never);
    expect(result.verdict).toMatchObject({ verdict: "blocked", reason: "allergen:sesame" });
  });

  // A scanned label whose complete printed list omits sesame (an OCR miss or an old label): on
  // its own it reads "No sesame listed on the label".
  const label = { name: "Trail mix bar", servingGrams: 40, per100g: { energy_kcal: 200 },
    ingredientsText: "Rice flour, sunflower oil, salt." };

  it("label branch: the catalog's sesame in row 1,001 blocks despite a sesame-free label", async () => {
    seed();
    const result = await groundItem(fake(), USER, item as never, label as never, profile as never,
      searchFoods as never);
    expect(result.verdict).toMatchObject({ verdict: "blocked", reason: "allergen:sesame" });
  });

  it("label branch: with page 2 unread, the label never clears sesame (t18 r4)", async () => {
    seed();
    state.failFrom.catalog_ingredients = PAGE_SIZE;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await groundItem(fake(), USER, item as never, label as never, profile as never,
      searchFoods as never);
    expect(result.verdict.verdict).toBe("unverified");
    expect(result.verdict.allergens).toContainEqual(expect.objectContaining({
      allergen: "sesame", outcome: "unknown", text: "Check the label for sesame" }));
    // The card beside it says the same, not "No sesame listed on the label".
    const card = labelFoodOf(label as never, profile as never, result.storedEvidence,
      result.checkedAllergens, result.allergenTags, result.ingredientsUnread === true);
    expect(card?.allergenWarnings).toEqual([{ allergen: "sesame", outcome: "unknown",
      text: "Check the label for sesame" }]);
  });

  it("is never allowed when page 2 fails: the tags are unread, not shorter", async () => {
    seed();
    state.failFrom.catalog_ingredients = PAGE_SIZE;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await groundItem(fake(), USER, item as never, null, profile as never,
      searchFoods as never);
    expect(result.verdict.verdict).not.toBe("allowed");
  });
});

describe("the facet warm's cache check (lib/foods/facet-warm.ts existingFacets)", () => {
  // 100 foods × every cached facet: 2,500 rows, so the cache answer spans three pages.
  const foods = Array.from({ length: 100 }, (_, i) => ({
    identity: { kind: "catalog_revision" as const, id: 500 + i }, name: `Food ${i}`,
    brand: "Plain brand", category: "prepared food", serving: "ready to eat",
    ingredientsText: "rice, water" }));
  const seed = () => {
    state.tables.food_facets = foods.flatMap((food) => {
      const hash = inputHash({ name: food.name, brand: food.brand, description: food.category,
        preparation: food.serving, ingredientsText: food.ingredientsText });
      // Each facet at its own current rubric (O3: the occasion facets are v2).
      return FACETS.map((facet) => ({ food_key: `catalog_revision:${food.identity.id}`,
        input_hash: hash, facet, rubric_version: facetRubricVersion(facet) }));
    });
  };

  it("sees every cached judgment past 1,000 rows and asks the model nothing", async () => {
    seed();
    expect(state.tables.food_facets.length).toBeGreaterThan(2 * PAGE_SIZE);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await ensureFacets(foods, { admin: fake(), userId: USER });
    expect(result).toMatchObject({ judged: 0, skipped: 100 * FACETS.length, errors: 0 });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("fails the read on a failed page 2: no judgment is called missing, no model call", async () => {
    seed();
    state.failFrom.food_facets = PAGE_SIZE;
    const result = await ensureFacets(foods, { admin: fake(), userId: USER });
    expect(result).toMatchObject({ judged: 0, skipped: 0, errors: 1, batches: [] });
    expect(systemOne).not.toHaveBeenCalled();
  });
});

describe("Eats-list reads (t18 r5)", () => {
  /** `count` of the account's own foods on Eats, each with a ref, a name and (optionally) every
   *  warm sentinel (human_food v1, the four occasion facets v2) at the food's current input hash. */
  function seedEats(count: number, cached: boolean): void {
    const ids = Array.from({ length: count }, (_, i) => `ee-${pad(i)}`);
    state.tables.user_food_prefs = ids.map((id) =>
      ({ user_id: USER, food_ref_id: id, status: "eats", role: null }));
    state.tables.food_refs = ids.map((id) =>
      ({ id, kind: "user", catalog_food_id: null, user_food_id: `uf-${id}`,
        user_foods: { name: `Eats ${id}` } }));
    state.tables.user_foods = ids.map((id) =>
      ({ id: `uf-${id}`, user_id: USER, name: `Eats ${id}`, rev: 1, deleted_at: null }));
    state.tables.food_facets = cached ? ids.flatMap((id) => {
      const key = warmFoodCacheKey({ identity: { kind: "user_food", id: `uf-${id}`, rev: 1 }, name: `Eats ${id}` });
      return (["human_food", ...OCCASION_FACETS] as const).map((facet) => ({ food_key: key.foodKey,
        input_hash: key.inputHash, facet, rubric_version: facetRubricVersion(facet) }));
    }) : [];
  }

  it("the Eats warm sees all 1,500 cached foods and warms none", async () => {
    seedEats(1500, true);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await warmEatsFacets(fake(), USER);
    expect(result).toMatchObject({ foods: 1500, warmed: 0, skipped: 1500, errors: 0 });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("the Eats warm warms nothing when page 2 of the prefs fails", async () => {
    seedEats(1500, false);
    state.failFrom.user_food_prefs = PAGE_SIZE;
    const result = await warmEatsFacets(fake(), USER);
    expect(result).toMatchObject({ foods: 0, warmed: 0, errors: 1 });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("the Eats warm makes no model call when a human_food cache page fails", async () => {
    seedEats(1500, true);
    state.failAfter.food_facets = 3; // three chunks answer, the fourth fails
    const result = await warmEatsFacets(fake(), USER);
    expect(result).toMatchObject({ foods: 1500, warmed: 0, errors: 1 });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("coach suggestions read every Eats name past 1,000, and fail on a failed page 2", async () => {
    seedEats(1500, false);
    const eats = await eatsForSuggestions(fake(), USER);
    expect(eats.all).toHaveLength(1500);
    state.failFrom.user_food_prefs = PAGE_SIZE;
    await expect(eatsForSuggestions(fake(), USER)).rejects.toThrow();
  });

  it("eligible foods fail, never shorten the list, when page 2 of the Eats prefs fails", async () => {
    seedEats(1500, false);
    state.failFrom.user_food_prefs = PAGE_SIZE;
    await expect(eligibleFoods(fake(), USER)).rejects.toThrow();
  });
});
