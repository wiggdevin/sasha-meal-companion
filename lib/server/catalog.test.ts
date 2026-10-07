import { describe, expect, it, vi } from "vitest";
import {
  attributionFor, clientIp, getFoodDetail, NoActiveCatalogVersion, searchFoods, withRetryAfter,
  type FoodSearchHit,
} from "./catalog";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";
import { mapCatalogFoodHit } from "@/lib/server/coach";
import { allergenFacts } from "@/lib/coach/policy";
import { evaluatePolicy } from "@/lib/policy/constraints";

const VERSION = { data: { version_label: "fdc-2026-09" }, error: null };
const NO_VERSION = { data: null, error: null };
const EMPTY = { data: [], error: null };

const ROW = {
  catalog_food_id: 7, revision_id: 70, description: "Chicken, breast, roasted", brand: null,
  source: "fdc_sr_legacy", quality_class: "analytical", quality_flags: [], prep_state: "roasted",
  score: 0.8123, pref_status: "eats", category: "Poultry Products", policy_categories: [],
  f_lexical: 0.9, f_trigram: 0.62, f_brand: 0, f_prep: 1, f_prior: 0.5, f_quality: 1, f_eats: 1,
};

/**
 * The account's own rules, as its `constraint_profiles` row. They used to be a constant in code;
 * since D1 §6.1 (PRD R2) the row is the only place a restriction exists, so a case that proves
 * blocking seeds the row the policy actually reads (lib/server/catalog.ts:130). Cases that assert
 * `allowed` on a category or an allergen keep no row: nothing is restricted for a new account.
 */
const RULES = { data: { ...TEST_PROFILE }, error: null };

/** A Supabase client with just the surface `lib/server/catalog.ts` uses. */
function clientWith(opts: { version?: unknown; rpc?: unknown; revision?: unknown; pref?: unknown;
  ingredients?: unknown; profile?: unknown; refs?: unknown; mapped?: unknown;
  portions?: unknown; nutrients?: unknown }) {
  const rpc = vi.fn().mockResolvedValue(opts.rpc ?? { data: [], error: null });
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "order", "limit", "is", "range"]) chain[m] = vi.fn(self);
    /**
     * `.in(column, values)` FILTERS the stub rows, the way the database would. Answering from the
     * table name alone let a lookup that passed only the first hit's id still satisfy a two-hit
     * test — the truncated IN list was invisible.
     */
    /**
     * Chainable AND awaitable: `refIdsByCatalogFood` and the allergen-evidence reads await
     * `.in(...)` directly, but `allergenTagsByRevision`'s keyset pagination (review round 2,
     * sol/BLOCK) chains `.order().order()...limit()` after it and awaits THAT instead. `.in()`
     * used to always return a Promise, which broke the second shape (`.order is not a function`
     * on a Promise) — it now returns `chain` itself (already chainable) with a `.then` attached,
     * so both an immediate `await` and a further chain both resolve to the same filtered answer.
     */
    chain.in = vi.fn((column: string, values: unknown[]) => {
      const answer = (table === "food_refs" ? (opts.refs ?? EMPTY)
        : table === "user_foods" ? (opts.mapped ?? EMPTY)
        : table === "catalog_portions" ? (opts.portions ?? EMPTY)
        : table === "catalog_food_nutrients" ? (opts.nutrients ?? EMPTY)
        : (opts.ingredients ?? EMPTY)) as { data: unknown; error: unknown };
      const wanted = new Set(values);
      const filtered = answer.error || !Array.isArray(answer.data) ? answer
        : { ...answer,
          data: (answer.data as Record<string, unknown>[]).filter((row) => wanted.has(row[column])) };
      chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(filtered).then(resolve, reject);
      return chain;
    });
    chain.maybeSingle = vi.fn().mockResolvedValue(
      table === "catalog_versions" ? (opts.version ?? VERSION)
        : table === "constraint_profiles" ? (opts.profile ?? { data: null, error: null })
        : table === "food_refs" ? (opts.pref ?? { data: null, error: null })
        : (opts.revision ?? { data: null, error: null })
    );
    return chain;
  });
  return { rpc, from } as never;
}

describe("attributionFor", () => {
  it("names Open Food Facts and the ODbL", () => {
    expect(attributionFor("off", "2026-09-01")).toBe("Data from Open Food Facts (ODbL)");
  });
  it("names the USDA source and the version label", () => {
    expect(attributionFor("fdc_sr_legacy", "fdc-2026-09")).toBe(
      "USDA FoodData Central — SR Legacy (fdc-2026-09)"
    );
  });
});

describe("clientIp", () => {
  it("trusts only x-real-ip, never a client-supplied x-forwarded-for (scale S2)", () => {
    const real = new Request("https://a.test/x", { headers: { "x-real-ip": "1.2.3.4" } });
    expect(clientIp(real)).toBe("1.2.3.4");
    const forged = new Request("https://a.test/x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(clientIp(forged)).toBe("unknown");
  });
  it("falls back to a constant when the header is absent", () => {
    expect(clientIp(new Request("https://a.test/x"))).toBe("unknown");
  });
});

describe("withRetryAfter", () => {
  it("copies status and body and adds the header", async () => {
    const res = withRetryAfter(new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }), 60);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
});

describe("searchFoods", () => {
  it("503s when no catalog version is active", async () => {
    await expect(searchFoods(clientWith({ version: NO_VERSION }), { q: "chicken" }))
      .rejects.toBeInstanceOf(NoActiveCatalogVersion);
  });

  it("passes the parsed query, brand, prep and a clamped limit to the RPC", async () => {
    const client = clientWith({ rpc: { data: [ROW], error: null } });
    await searchFoods(client, { q: "chicken thigh roasted brand:Kirkland", limit: 99 });
    expect((client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "catalog_search",
      { p_q: "chicken thigh", p_brand: "Kirkland", p_prep: "roasted", p_limit: 25 }
    );
  });

  it("maps RPC rows onto the wire shape and reports the query class and version", async () => {
    const res = await searchFoods(clientWith({ rpc: { data: [ROW], error: null } }), { q: "chicken" });
    expect(res.catalogVersion).toBe("fdc-2026-09");
    expect(res.queryClass).toBe("generic");
    expect(res.hits).toEqual([{
      catalogFoodId: 7, revisionId: 70, description: "Chicken, breast, roasted", brand: null,
      source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "roasted",
      score: 0.8123, prefStatus: "eats", policyCategories: [],
      policy: { verdict: "allowed" },
      // No catalog_portions/catalog_food_nutrients rows seeded for this fixture: no serving data
      // yet, but `portions` still carries the always-present synthetic 100 g tail.
      kcalPer100g: null, per100g: { kcal: null, protein: null, carbs: null, fat: null },
      portions: [{ id: null, label: "100 g", grams: 100, kcal: null }], defaultPortion: null,
    }]);
  });

  it("carries real portions and the simplified per-100 g panel through to the search hit", async () => {
    const res = await searchFoods(clientWith({
      rpc: { data: [ROW], error: null },
      portions: { data: [
        { food_revision_id: 70, id: 5, description: "3 oz", gram_weight: 85, is_default: true, seq: 1 },
        { food_revision_id: 70, id: 6, description: "1 breast", gram_weight: 172, is_default: false, seq: 2 },
      ], error: null },
      nutrients: { data: [
        { food_revision_id: 70, nutrient_code: "energy_kcal", amount_per_100g: 165 },
        { food_revision_id: 70, nutrient_code: "protein", amount_per_100g: 31 },
        { food_revision_id: 70, nutrient_code: "carbohydrate", amount_per_100g: 0 },
        { food_revision_id: 70, nutrient_code: "fat_total", amount_per_100g: 3.6 },
      ], error: null },
    }), { q: "chicken" });
    const hit = res.hits[0];
    expect(hit.kcalPer100g).toBe(165);
    expect(hit.per100g).toEqual({ kcal: 165, protein: 31, carbs: 0, fat: 3.6 });
    expect(hit.defaultPortion).toEqual({ id: "5", label: "3 oz", grams: 85, kcal: 140 });
    expect(hit.portions).toEqual([
      { id: "5", label: "3 oz", grams: 85, kcal: 140 },
      { id: "6", label: "1 breast", grams: 172, kcal: 284 },
      { id: null, label: "100 g", grams: 100, kcal: 165 },
    ]);
  });

  it("blocks a hit whose ingredients carry an avoided allergen", async () => {
    const res = await searchFoods(clientWith({
      rpc: { data: [ROW], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: ["dairy"] }], error: null },
      profile: RULES,
    }), { q: "chicken" });
    expect(res.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:dairy" });
  });

  it("blocks a hit whose ingredient TEXT names an account-defined allergen missing from its " +
    "stored tags (finding #4: search never threaded ingredientsText into the policy)", async () => {
    const res = await searchFoods(clientWith({
      rpc: { data: [ROW], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [], seq: 1,
        raw_text: "Apple juice concentrate, water" }], error: null },
      profile: RULES,
    }), { q: "chicken" });
    expect(res.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:apple" });
  });

  it("ORCHESTRATOR fix (round 7, item 5): blocks a hit whose only signal is a parsed ingredient " +
    "NAME with no verbatim raw_text — search must read the same signal getFoodDetail already " +
    "does, not only stored tags", async () => {
    const res = await searchFoods(clientWith({
      rpc: { data: [ROW], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [], seq: 1, name: "peanut" }],
        error: null },
      profile: { data: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [],
        banned_categories: [] }, error: null },
    }), { q: "chicken" });
    expect(res.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });
  });

  it("sol BLOCK (finding #3, review round 1): a parsed ingredient NAME still names an allergen " +
    "even when verbatim raw_text is ALSO present — namedAllergenHints only ever adds `listed`, " +
    "it must never be skipped just because some other row's text exists", async () => {
    const res = await searchFoods(clientWith({
      rpc: { data: [ROW], error: null },
      ingredients: { data: [
        { food_revision_id: 70, allergen_tags: [], seq: 1, name: "water",
          raw_text: "Water, rice, salt." },
        { food_revision_id: 70, allergen_tags: [], seq: 2, name: "peanut" },
      ], error: null },
      profile: { data: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [],
        banned_categories: [] }, error: null },
    }), { q: "chicken" });
    // The old code read `nameHints = revisionText ? [] : namedAllergenHints(...)` — gating the
    // parsed-name signal off entirely whenever ANY revision text existed, even seq 1's own
    // fragment that says nothing about peanut. namedAllergenHints only ever ADDS `listed` (it
    // never certifies completeness — that stays `ingredientsTextIsLabel`'s job), so a row's own
    // parsed name must still be read regardless of what other rows' raw_text says.
    expect(res.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });
  });

  it("sol BLOCK (finding #2, review round 1): a later row's OWN raw_text — the label really was " +
    "split across rows, not just parsed into names — must not let seq 1's fragment alone clear " +
    "an allergen the split-off row actually names", async () => {
    const res = await searchFoods(clientWith({
      rpc: { data: [ROW], error: null },
      ingredients: { data: [
        { food_revision_id: 70, allergen_tags: [], seq: 1, raw_text: "Water, rice, salt." },
        { food_revision_id: 70, allergen_tags: [], seq: 2, raw_text: "Peanut oil." },
      ], error: null },
      profile: { data: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [],
        banned_categories: [] }, error: null },
    }), { q: "chicken" });
    // Seq 1's own text ("Water, rice, salt.") reads as a complete, terminated, three-item list on
    // its own — the bug cleared peanut outright. The second row's own raw_text proves the full
    // label was never just seq 1's fragment, so the joined text must still catch "peanut" as
    // LISTED even though it can no longer certify completeness.
    expect(res.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });
  });

  it("marks a hit unverified when nothing knows its ingredients and she does not eat it", async () => {
    const res = await searchFoods(clientWith({
      rpc: { data: [{ ...ROW, pref_status: null }], error: null },
    }), { q: "chicken" });
    expect(res.hits[0].policy).toMatchObject({ verdict: "unverified" });
  });

  it("rounds a 6-dp RPC score to 4 dp on the wire", async () => {
    const row = { ...ROW, score: 0.812345 };
    const res = await searchFoods(clientWith({ rpc: { data: [row], error: null } }), { q: "chicken" });
    expect(res.hits[0].score).toBe(0.8123);
  });

  it("reports no auto-resolve on a single hit", async () => {
    const res = await searchFoods(clientWith({ rpc: { data: [ROW], error: null } }), { q: "chicken" });
    expect(res.autoResolve).toBeNull();
  });

  it("reports an auto-resolve with its margin when the top two clear the threshold", async () => {
    const rows = [{ ...ROW, score: 0.95 }, { ...ROW, revision_id: 71, score: 0.5 }];
    const res = await searchFoods(clientWith({ rpc: { data: rows, error: null } }), { q: "chicken" });
    expect(res.autoResolve).toEqual({ revisionId: 70, score: 0.95, margin: 0.45 });
  });

  it("turns an RPC error into a 500 without the SQL text", async () => {
    const client = clientWith({ rpc: { data: null, error: { message: 'relation "x" does not exist' } } });
    await expect(searchFoods(client, { q: "chicken" })).rejects.toMatchObject({
      status: 500, code: "search_failed",
    });
    await expect(searchFoods(client, { q: "chicken" })).rejects.not.toThrow(/relation/);
  });
  it("blocks a hit whose policy_categories name a banned key (T1 round 2)", async () => {
    const row = { ...ROW, pref_status: null, policy_categories: ["onion_garlic"] };
    const client = clientWith({
      rpc: { data: [row], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
      profile: RULES,
    });
    const out = await searchFoods(client, { q: "onion" });
    expect(out.hits[0].policyCategories).toEqual(["onion_garlic"]);
    expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "category:onion_garlic" });
  });

  it("routes a misspelled discovery term to the SQL trigram and synonym search unchanged", async () => {
    const client = clientWith({ rpc: { data: [], error: null } });
    await searchFoods(client, { q: "brocoli" });
    expect((client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "catalog_search", { p_q: "brocoli", p_brand: null, p_prep: null, p_limit: 25 });
  });

  it("returns a policy-category alias's blocked row with the server's mark, not hidden", async () => {
    // foodDiscoveryTerms("onion and garlic") sends "garlic" as its own request; the answer
    // still carries the account's category verdict for the client to render.
    const row = { ...ROW, description: "Garlic, raw", pref_status: null, policy_categories: null,
      category: "Vegetables and Vegetable Products" };
    const out = await searchFoods(clientWith({
      rpc: { data: [row], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
      profile: RULES,
    }), { q: "garlic" });
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "category:onion_garlic" });
  });

  it("stops blocking that key once she switches it off", async () => {
    const row = { ...ROW, pref_status: null, policy_categories: ["onion_garlic"] };
    const client = clientWith({
      rpc: { data: [row], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
      profile: { data: { banned_categories: ["simple_sugars"] }, error: null },
    });
    const out = await searchFoods(client, { q: "onion" });
    expect(out.hits[0].policy).toEqual({ verdict: "allowed" });
  });

  it("derives a search hit's categories when the column was never annotated", async () => {
    // NULL is "never annotated" and search is the path she uses most, so it derives rather than
    // reading the absence as a clean result.
    const row = { ...ROW, catalog_food_id: 8, revision_id: 80, description: "Onions, raw",
      category: "Vegetables and Vegetable Products", pref_status: null,
      policy_categories: null };
    const out = await searchFoods(clientWith({
      rpc: { data: [row], error: null },
      ingredients: { data: [{ food_revision_id: 80, allergen_tags: [] }], error: null },
      profile: RULES,
    }), { q: "onion" });
    expect(out.hits[0].policyCategories).toEqual(["onion_garlic"]);
    expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "category:onion_garlic" });
  });

  it("derives a search hit using the PROVIDER CATEGORY the RPC now returns", async () => {
    // "Honey" earns `simple_sugars` from its description alone; the Beverages category is the only
    // thing that takes it away. Stop passing `category` into the mapper and this hit blocks.
    const row = { ...ROW, catalog_food_id: 9, revision_id: 90, description: "Honey",
      category: "Beverages", pref_status: null, policy_categories: null };
    const out = await searchFoods(clientWith({
      rpc: { data: [row], error: null },
      ingredients: { data: [{ food_revision_id: 90, allergen_tags: [] }], error: null },
    }), { q: "honey drink" });
    expect(out.hits[0].policyCategories).toEqual([]);
    expect(out.hits[0].policy).toEqual({ verdict: "allowed" });
  });

  it("trusts an annotated-clean search hit rather than re-deriving it", async () => {
    // '{}' is "annotated, nothing banned". Re-deriving here would undo every hand correction the
    // annotate run made, and would make a clean row cost a regex pass per hit per search.
    const out = await searchFoods(clientWith({
      rpc: { data: [{ ...ROW, pref_status: null, policy_categories: [] }], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
    }), { q: "chicken" });
    expect(out.hits[0].policyCategories).toEqual([]);
    expect(out.hits[0].policy).toEqual({ verdict: "allowed" });
  });

  it("blocks a hit she has marked Avoid, reason avoid_list (T1)", async () => {
    const client = clientWith({ rpc: { data: [{ ...ROW, pref_status: "avoid" }], error: null } });
    const out = await searchFoods(client, { q: "onion" });
    expect(out.hits[0].prefStatus).toBe("avoid");
    expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  /**
   * T9 §4. A coach action is the only writer of `avoid_food_ref_ids` (lib/coach/types.ts), and
   * until this the search and detail evidence builders both passed `foodRefId: null` — so the
   * list blocked the barcode, capture and commit paths and nothing she actually looks at.
   */
  it("blocks a hit whose food_ref the coach put on avoid_food_ref_ids", async () => {
    const client = clientWith({
      rpc: { data: [{ ...ROW, pref_status: null }], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
      refs: { data: [{ id: "ref-7", catalog_food_id: 7 }], error: null },
      profile: { data: { avoid_food_ref_ids: ["ref-7"] }, error: null },
    });
    const out = await searchFoods(client, { q: "chicken" });
    expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("still names the allergen first when a coach-listed hit also carries one", async () => {
    const client = clientWith({
      rpc: { data: [{ ...ROW, pref_status: null }], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: ["dairy"] }], error: null },
      refs: { data: [{ id: "ref-7", catalog_food_id: 7 }], error: null },
      profile: { data: { ...TEST_PROFILE, avoid_food_ref_ids: ["ref-7"] }, error: null },
    });
    const out = await searchFoods(client, { q: "chicken" });
    expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:dairy" });
  });

  /**
   * A mapped food has TWO refs — lib/foods/prefs-client.ts writes her mark to the catalog ref and
   * to her own food's ref — and `avoid_food_ref_ids` is a free uuid list, so the coach may name
   * either. Checking only the catalog ref let search answer "allowed" for a food commit refuses.
   */
  it("blocks a hit when the coach listed her own food's ref, not the catalog one", async () => {
    const client = clientWith({
      rpc: { data: [{ ...ROW, pref_status: null }], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
      refs: { data: [{ id: "ref-catalog-7", catalog_food_id: 7 }], error: null },
      mapped: { data: [{ catalog_food_id: 7, food_refs: [{ id: "ref-user-7" }] }], error: null },
      profile: { data: { avoid_food_ref_ids: ["ref-user-7"] }, error: null },
    });
    const out = await searchFoods(client, { q: "chicken" });
    expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  /**
   * Search never touched food_refs before T9 §4, so a read error there must not take the whole
   * screen down over a policy refinement. Allergens, categories and her own mark still apply.
   */
  it("keeps the mapped ref when only the catalog_food_id read fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = clientWith({
        rpc: { data: [{ ...ROW, pref_status: null }], error: null },
        ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
        refs: { data: null, error: { message: "food_refs is down" } },
        mapped: { data: [{ catalog_food_id: 7, food_refs: [{ id: "ref-user-7" }] }], error: null },
        profile: { data: { avoid_food_ref_ids: ["ref-user-7"] }, error: null },
      });
      const out = await searchFoods(client, { q: "chicken" });
      expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("degrades to no ref, and says so, when the food_refs read fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = clientWith({
        rpc: { data: [{ ...ROW, pref_status: null }], error: null },
        ingredients: { data: [{ food_revision_id: 70, allergen_tags: ["dairy"] }], error: null },
        refs: { data: null, error: { message: 'relation "food_refs" does not exist' } },
        profile: { data: { ...TEST_PROFILE, avoid_food_ref_ids: ["ref-catalog-7"] }, error: null },
      });
      const out = await searchFoods(client, { q: "chicken" });
      expect(out.hits).toHaveLength(1);
      // The allergen still blocks it; only the avoid_food_ref_ids half is lost.
      expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:dairy" });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  /** A deleted own food is not a mapping any more — lib/foods/prefs-client.ts skips it too. */
  it("ignores a mapped food she has deleted", async () => {
    const client = clientWith({
      rpc: { data: [{ ...ROW, pref_status: null }], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
      refs: { data: [{ id: "ref-catalog-7", catalog_food_id: 7 }], error: null },
      mapped: { data: [], error: null },   // the `is("deleted_at", null)` filter removed the row
      profile: { data: { avoid_food_ref_ids: ["ref-user-7"] }, error: null },
    });
    const out = await searchFoods(client, { q: "chicken" });
    expect(out.hits[0].policy).toEqual({ verdict: "allowed" });
    const from = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const userFoods = from.mock.results
      .find((_r, i) => from.mock.calls[i][0] === "user_foods")?.value as Record<string, unknown>;
    expect(userFoods.is).toHaveBeenCalledWith("deleted_at", null);
  });

  /** Two hits, one listed: catches a map lookup that reads hits[0] for every row, or mixes ids. */
  it("blocks only the listed hit when the page holds two", async () => {
    const rows = [
      { ...ROW, catalog_food_id: 7, revision_id: 70, pref_status: null },
      { ...ROW, catalog_food_id: 8, revision_id: 80, description: "Turkey breast, roasted",
        pref_status: null },
    ];
    const client = clientWith({
      rpc: { data: rows, error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] },
        { food_revision_id: 80, allergen_tags: [] }], error: null },
      refs: { data: [{ id: "ref-catalog-7", catalog_food_id: 7 },
        { id: "ref-catalog-8", catalog_food_id: 8 }], error: null },
      profile: { data: { avoid_food_ref_ids: ["ref-catalog-8"] }, error: null },
    });
    const out = await searchFoods(client, { q: "poultry" });
    expect(out.hits[0].catalogFoodId).toBe(7);
    expect(out.hits[0].policy).toEqual({ verdict: "allowed" });
    expect(out.hits[1].catalogFoodId).toBe(8);
    expect(out.hits[1].policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  /**
   * Precedence, and it matters medically: a food she has marked Eats can still be one the coach
   * has ruled out for her — a flare, a new medication. `evaluatePolicy` puts `avoid_food_ref_ids`
   * above `onEatsList`; an implementation that answered "allowed" on the Eats mark first would
   * show her a food the commit path refuses.
   */
  it("blocks a hit the coach listed even where she has marked it Eats", async () => {
    const client = clientWith({
      rpc: { data: [{ ...ROW, catalog_food_id: 7, pref_status: "eats" }], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
      refs: { data: [{ id: "ref-catalog-7", catalog_food_id: 7 }], error: null },
      profile: { data: { avoid_food_ref_ids: ["ref-catalog-7"] }, error: null },
    });
    const out = await searchFoods(client, { q: "chicken" });
    expect(out.hits[0].prefStatus).toBe("eats");
    expect(out.hits[0].policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("leaves a hit whose ref is not on the list alone", async () => {
    const client = clientWith({
      rpc: { data: [ROW], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
      refs: { data: [{ id: "ref-7", catalog_food_id: 7 }], error: null },
      profile: { data: { avoid_food_ref_ids: ["ref-other"] }, error: null },
    });
    const out = await searchFoods(client, { q: "chicken" });
    expect(out.hits[0].policy).toEqual({ verdict: "allowed" });
  });

  it("leaves a hit she eats allowed", async () => {
    const client = clientWith({
      rpc: { data: [ROW], error: null },
      ingredients: { data: [{ food_revision_id: 70, allergen_tags: [] }], error: null },
    });
    const out = await searchFoods(client, { q: "chicken" });
    expect(out.hits[0].policy).toEqual({ verdict: "allowed" });
  });
});

describe("getFoodDetail", () => {
  it("404s on an unknown or inactive catalog food", async () => {
    await expect(getFoodDetail(clientWith({}), 404)).rejects.toMatchObject({
      status: 404, code: "not_found",
    });
  });

  it("503s when no catalog version is active", async () => {
    await expect(getFoodDetail(clientWith({ version: NO_VERSION }), 7))
      .rejects.toBeInstanceOf(NoActiveCatalogVersion);
  });

  it("assembles per-100 g values, portions, ingredients and the attribution", async () => {
    const revision = { data: {
      id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
      category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
      quality_flags: [],
      catalog_foods: { source: "fdc_sr_legacy" },
      catalog_food_nutrients: [
        { nutrient_code: "protein", amount_per_100g: 31, catalog_nutrients: { unit: "g" } },
        { nutrient_code: "vitamin_d", amount_per_100g: null, catalog_nutrients: { unit: "µg" } },
      ],
      catalog_portions: [{ id: 5, description: "3 oz", gram_weight: 85, is_default: true, seq: 1 }],
      catalog_ingredients: [{ seq: 1, name: "chicken", allergen_tags: [] }],
    }, error: null };
    const detail = await getFoodDetail(clientWith({ revision, pref: { data: { user_food_prefs: [{ status: "avoid" }] }, error: null } }), 7);
    expect(detail.per100g).toEqual({
      protein: { amount: 31, unit: "g" },
      vitamin_d: { amount: null, unit: "µg" },
    });
    expect(detail.portions).toEqual([{ id: 5, description: "3 oz", gramWeight: 85, isDefault: true }]);
    // No energy code on this fixture: kcalPer100g (and the simplified per100g.kcal) stay null —
    // the rest of the simplified panel still carries protein.
    expect(detail.kcalPer100g).toBeNull();
    expect(detail.simplePer100g).toEqual({ kcal: null, protein: 31, carbs: null, fat: null });
    // The one real portion is the default (isDefault), followed by the always-present 100 g tail
    // — kcal is null throughout since this fixture has no energy_kcal/energy_kcal_calc.
    expect(detail.defaultPortion).toEqual({ id: "5", label: "3 oz", grams: 85, kcal: null });
    expect(detail.servingPortions).toEqual([
      { id: "5", label: "3 oz", grams: 85, kcal: null },
      { id: null, label: "100 g", grams: 100, kcal: null },
    ]);
    expect(detail.ingredients).toEqual([{ seq: 1, name: "chicken", allergenTags: [] }]);
    expect(detail.attribution).toBe("USDA FoodData Central — SR Legacy (fdc-2026-09)");
    expect(detail.prefStatus).toBe("avoid");
    // T1: her own Avoid mark is the block, not a decoration on an "allowed" row.
    expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
    expect(detail.score).toBe(0);
  });

  it("r4 BLOCK #10 (reproduced): a parsed ingredient NAME still names an allergen when no " +
    "verbatim raw_text is present and the row carries no explicit allergen_tags entry of its " +
    "own — namedAllergenHints adds it to allergenTags without certifying completeness", async () => {
      const revision = { data: {
        id: 70, catalog_food_id: 7, description: "Trail mix", brand: null,
        category: "Snacks", prep_state: null, quality_class: "crowd", quality_flags: [],
        catalog_foods: { source: "off" },
        catalog_food_nutrients: [], catalog_portions: [],
        // No raw_text anywhere: the verbatim statement was never captured for this row.
        catalog_ingredients: [{ seq: 1, name: "peanut", allergen_tags: [] }],
      }, error: null };
      const profile = { data: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [],
        banned_categories: [] }, error: null };
      const detail = await getFoodDetail(clientWith({ revision, profile,
        pref: { data: { user_food_prefs: [] }, error: null } }), 7);
      // sol BLOCK (finding #1, fixer pass): `ingredientsText` is now the same `completenessText`
      // join the policy itself reads (never seq 1's raw fragment alone) — here that join falls
      // back to the parsed NAME ("peanut") because no row carries its own raw_text at all.
      expect(detail.ingredientsText).toBe("peanut");
      expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });
    });

  it("sol BLOCK (finding #2, review round 1): a later row's OWN raw_text on the detail sheet " +
    "must not let seq 1's fragment alone clear an allergen the split-off row actually names",
    async () => {
      const revision = { data: {
        id: 70, catalog_food_id: 7, description: "Trail mix", brand: null,
        category: "Snacks", prep_state: null, quality_class: "crowd", quality_flags: [],
        catalog_foods: { source: "off" },
        catalog_food_nutrients: [], catalog_portions: [],
        catalog_ingredients: [
          { seq: 1, name: "water", allergen_tags: [], raw_text: "Water, rice, salt." },
          { seq: 2, name: "peanut oil", allergen_tags: [], raw_text: "Peanut oil." },
        ],
      }, error: null };
      const profile = { data: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [],
        banned_categories: [] }, error: null };
      const detail = await getFoodDetail(clientWith({ revision, profile,
        pref: { data: { user_food_prefs: [] }, error: null } }), 7);
      // Seq 1 alone reads as complete on its own; the second row's own raw_text proves it is only
      // a fragment of the printed label, and the joined text still catches "peanut" as LISTED.
      expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });
    });

  it("sol BLOCK (review round 2): a later parsed ingredient NAME with no raw_text or " +
    "allergen_tags of its own still names an allergen even though seq 1 carries raw_text — " +
    "detail must read the same nameHints signal search already reads unconditionally, not only " +
    "when ingredientsText is empty", async () => {
      const revision = { data: {
        id: 70, catalog_food_id: 7, description: "Trail mix", brand: null,
        category: "Snacks", prep_state: null, quality_class: "crowd", quality_flags: [],
        catalog_foods: { source: "off" },
        catalog_food_nutrients: [], catalog_portions: [],
        catalog_ingredients: [
          { seq: 1, name: "water", allergen_tags: [], raw_text: "Water, rice, salt." },
          { seq: 2, name: "peanut", allergen_tags: [] },
        ],
      }, error: null };
      const profile = { data: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [],
        banned_categories: [] }, error: null };
      const detail = await getFoodDetail(clientWith({ revision, profile,
        pref: { data: { user_food_prefs: [] }, error: null } }), 7);
      // The bug: `nameHints = ingredientsText ? [] : namedAllergenHints(...)` skipped this entirely
      // because seq 1's own unrelated raw_text made `ingredientsText` truthy — the exact same class
      // of bug `searchFoods` already fixed (finding #3, review round 1). Search would block this
      // same revision; detail must too.
      expect(detail.ingredientsText).toBe("Water, rice, salt.");
      expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });
    });

  it("sol BLOCK (finding #1, fixer pass): the coach's own re-check (lib/server/coach.ts " +
    "mapCatalogFoodHit) must catch a split label's seq-2 raw_text too — ingredientsText and " +
    "ingredientsTextIsLabel have to describe the same string, or the coach scans only seq 1's " +
    "fragment and misses the allergen the split-off row actually names", async () => {
      const revision = { data: {
        id: 70, catalog_food_id: 7, description: "Trail mix", brand: null,
        category: "Snacks", prep_state: null, quality_class: "crowd", quality_flags: [],
        catalog_foods: { source: "off" },
        catalog_food_nutrients: [], catalog_portions: [],
        catalog_ingredients: [
          { seq: 1, name: "water", allergen_tags: [], raw_text: "Water, rice, salt." },
          // No tag and no parsed name says "peanut" — only the joined completeness text (seq 2's
          // own raw_text) can catch it, isolating this from the separate namedAllergenHints fix.
          { seq: 2, name: "flavoring", allergen_tags: [], raw_text: "Contains peanut oil." },
        ],
      }, error: null };
      const profile = { data: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [],
        banned_categories: [] }, error: null };
      const detail = await getFoodDetail(clientWith({ revision, profile,
        pref: { data: { user_food_prefs: [] }, error: null } }), 7);
      // Isolate mapCatalogFoodHit's own ingredientsText/ingredientsTextIsLabel plumbing from the
      // search hit's already-correct `policy` field and from the allergenTags fallback it feeds —
      // an "allowed" search hit with no tags means allergenTags comes back null, so only
      // ingredientsText/ingredientsTextIsLabel can carry the peanut mention through.
      const hit = { ...detail, policy: { verdict: "allowed" as const } } as unknown as FoodSearchHit;
      const mapped = mapCatalogFoodHit(hit, detail, "3f1b1a2c-0000-4000-8000-0000000000f2");
      expect(mapped.allergenTags).toBeNull();
      const verdict = evaluatePolicy(
        { avoid_allergens: ["peanut"], avoid_food_ref_ids: [], banned_categories: [] },
        {
          foodRefId: mapped.foodRefId, allergenTags: mapped.allergenTags ?? null,
          ...allergenFacts(mapped), foodName: mapped.name,
          category: mapped.category ?? null, onEatsList: false, onAvoidList: false,
        },
      );
      expect(verdict).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });
    });

  /**
   * 2026-10-02 DeepSeek audit (F2, MED): `getFoodDetail`'s own policy check passed `foodBrand` but
   * no `packaged` at all, so a branded-provider row with a blank brand string (the exact shape OFF
   * leaves when a store's own label carries no `brands` field, lib/server/off-map.ts) could still
   * read as a generic whole-food identity by name alone and clear through lib/policy/whole-foods.ts
   * ("Plain poultry has no dairy") — the same class finding round 2 called HIGH for the search path.
   */
  it("a branded/OFF revision with no ingredient rows and no brand string never gets whole-food " +
    "clearance (F2)", async () => {
    const revision = { data: {
      id: 70, catalog_food_id: 7, description: "Chicken breast", brand: null,
      category: "Poultry Products", prep_state: null, quality_class: "crowd", quality_flags: [],
      catalog_foods: { source: "off" },
      catalog_food_nutrients: [], catalog_portions: [],
      catalog_ingredients: [],
    }, error: null };
    const profile = { data: { avoid_allergens: ["dairy"], avoid_food_ref_ids: [],
      banned_categories: [] }, error: null };
    const detail = await getFoodDetail(clientWith({ revision, profile,
      pref: { data: { user_food_prefs: [] }, error: null } }), 7);
    expect(detail.policy).toMatchObject({ verdict: "unverified" });
    expect(detail.policy.allergens).toContainEqual(
      expect.objectContaining({ allergen: "dairy", outcome: "unknown",
        text: "Check the label for dairy" }));
  });

  it("blocks a detail whose food_ref the coach put on avoid_food_ref_ids (T9 §4)", async () => {
    const revision = { data: {
      id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
      category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
      quality_flags: [],
      catalog_foods: { source: "fdc_sr_legacy" },
      catalog_food_nutrients: [],
      catalog_portions: [],
      catalog_ingredients: [{ seq: 1, name: "chicken", allergen_tags: [] }],
    }, error: null };
    const detail = await getFoodDetail(clientWith({ revision,
      pref: { data: { user_food_prefs: [] }, error: null },
      refs: { data: [{ id: "ref-7", catalog_food_id: 7 }], error: null },
      profile: { data: { avoid_food_ref_ids: ["ref-7"] }, error: null } }), 7);
    expect(detail.prefStatus).toBeNull();
    expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("blocks a detail when the coach listed her own food's ref, and never throws (T9 §4)", async () => {
    const revision = { data: {
      id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
      category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
      quality_flags: [],
      catalog_foods: { source: "fdc_sr_legacy" },
      catalog_food_nutrients: [],
      catalog_portions: [],
      catalog_ingredients: [{ seq: 1, name: "chicken", allergen_tags: [] }],
    }, error: null };
    const detail = await getFoodDetail(clientWith({ revision,
      pref: { data: { user_food_prefs: [] }, error: null },
      refs: { data: [{ id: "ref-catalog-7", catalog_food_id: 7 }], error: null },
      mapped: { data: [{ catalog_food_id: 7, food_refs: [{ id: "ref-user-7" }] }], error: null },
      profile: { data: { avoid_food_ref_ids: ["ref-user-7"] }, error: null } }), 7);
    expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("keeps a detail's mapped ref when only the catalog-ref read fails (T9 §4)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const revision = { data: {
        id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
        category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
        quality_flags: [],
        catalog_foods: { source: "fdc_sr_legacy" },
        catalog_food_nutrients: [],
        catalog_portions: [],
        catalog_ingredients: [{ seq: 1, name: "chicken", allergen_tags: [] }],
      }, error: null };
      // Only the catalog-ref `.in()` read fails here; her mark still reads, which is why the
      // sheet renders at all. The both-reads-down case is the fail-closed test below.
      const detail = await getFoodDetail(clientWith({ revision,
        pref: { data: { user_food_prefs: [] }, error: null },
        refs: { data: null, error: { message: "food_refs is down" } },
        mapped: { data: [{ catalog_food_id: 7, food_refs: [{ id: "ref-user-7" }] }], error: null },
        profile: { data: { avoid_food_ref_ids: ["ref-user-7"] }, error: null } }), 7);
      expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  /**
   * The deliberate asymmetry, pinned so it cannot become an accident. Search degrades because it
   * never read food_refs before T9 §4; the detail sheet has answered `detail_failed` on that table
   * since before T9, and a sheet that renders "allowed" because it could not read her Avoid mark
   * is worse than one that says it could not be read. So when the whole table is down, detail
   * fails closed — it does not quietly drop to allowed.
   */
  it("fails a detail closed when the whole food_refs table is unreadable (T9 §4)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const revision = { data: {
        id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
        category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
        quality_flags: [],
        catalog_foods: { source: "fdc_sr_legacy" },
        catalog_food_nutrients: [],
        catalog_portions: [],
        catalog_ingredients: [{ seq: 1, name: "chicken", allergen_tags: [] }],
      }, error: null };
      const client = clientWith({ revision,
        // Both reads of food_refs are down: the mark read (maybeSingle) and the ref read (in).
        pref: { data: null, error: { message: "food_refs is down" } },
        refs: { data: null, error: { message: "food_refs is down" } },
        profile: { data: { avoid_food_ref_ids: ["ref-catalog-7"] }, error: null } });
      await expect(getFoodDetail(client, 7)).rejects.toMatchObject({
        status: 500, code: "detail_failed",
      });
    } finally {
      logged.mockRestore();
    }
  });

  it("blocks a detail the coach listed even where she has marked it Eats (T9 §4)", async () => {
    const revision = { data: {
      id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
      category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
      quality_flags: [],
      catalog_foods: { source: "fdc_sr_legacy" },
      catalog_food_nutrients: [],
      catalog_portions: [],
      catalog_ingredients: [{ seq: 1, name: "chicken", allergen_tags: [] }],
    }, error: null };
    const detail = await getFoodDetail(clientWith({ revision,
      pref: { data: { user_food_prefs: [{ status: "eats" }] }, error: null },
      refs: { data: [{ id: "ref-catalog-7", catalog_food_id: 7 }], error: null },
      profile: { data: { avoid_food_ref_ids: ["ref-catalog-7"] }, error: null } }), 7);
    expect(detail.prefStatus).toBe("eats");
    expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("marks a detail unverified when it has no ingredient rows and she does not eat it", async () => {
    const revision = { data: {
      id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
      category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
      quality_flags: [],
      catalog_foods: { source: "fdc_sr_legacy" },
      catalog_food_nutrients: [],
      catalog_portions: [],
      catalog_ingredients: [],
    }, error: null };
    const detail = await getFoodDetail(clientWith({ revision }), 7);
    expect(detail.policy).toMatchObject({ verdict: "unverified" });
  });

  it("derives the policy categories when the column was never annotated", async () => {
    // NULL means the annotate script has not reached this revision. Reading that as "checked,
    // none banned" would show five switches on and block nothing.
    const revision = { data: {
      id: 71, catalog_food_id: 8, description: "Onions, raw", brand: null,
      category: "Vegetables and Vegetable Products", policy_categories: null,
      prep_state: "raw", quality_class: "analytical", quality_flags: [],
      catalog_foods: { source: "fdc_sr_legacy" },
      catalog_food_nutrients: [],
      catalog_portions: [],
      catalog_ingredients: [{ seq: 1, name: "onion", allergen_tags: [] }],
    }, error: null };
    const detail = await getFoodDetail(clientWith({ revision, profile: RULES }), 8);
    expect(detail.policyCategories).toEqual(["onion_garlic"]);
    expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "category:onion_garlic" });
  });

  it("trusts an annotated-clean revision rather than re-deriving it", async () => {
    const revision = { data: {
      id: 73, catalog_food_id: 10, description: "Onions, raw", brand: null,
      category: "Vegetables and Vegetable Products", policy_categories: [],
      prep_state: "raw", quality_class: "analytical", quality_flags: [],
      catalog_foods: { source: "fdc_sr_legacy" },
      catalog_food_nutrients: [],
      catalog_portions: [],
      catalog_ingredients: [{ seq: 1, name: "onion", allergen_tags: [] }],
    }, error: null };
    const detail = await getFoodDetail(clientWith({ revision }), 10);
    expect(detail.policyCategories).toEqual([]);
    expect(detail.policy).toEqual({ verdict: "allowed" });
  });

  it("keeps the stored array when it has one, rather than re-deriving", async () => {
    const revision = { data: {
      id: 72, catalog_food_id: 9, description: "Onions, raw", brand: null,
      category: "Vegetables and Vegetable Products", policy_categories: ["beans"],
      prep_state: "raw", quality_class: "analytical", quality_flags: [],
      catalog_foods: { source: "fdc_sr_legacy" },
      catalog_food_nutrients: [],
      catalog_portions: [],
      catalog_ingredients: [{ seq: 1, name: "onion", allergen_tags: [] }],
    }, error: null };
    const detail = await getFoodDetail(clientWith({ revision, profile: RULES }), 9);
    expect(detail.policyCategories).toEqual(["beans"]);
    expect(detail.policy).toMatchObject({ verdict: "blocked", reason: "category:beans" });
  });

  it("turns a pref-read error into a 500 without the underlying message", async () => {
    const revision = { data: {
      id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
      category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
      quality_flags: [],
      catalog_foods: { source: "fdc_sr_legacy" },
      catalog_food_nutrients: [],
      catalog_portions: [],
      catalog_ingredients: [],
    }, error: null };
    const client = clientWith({ revision, pref: { data: null, error: { message: "boom" } } });
    await expect(getFoodDetail(client, 7)).rejects.toMatchObject({ status: 500, code: "detail_failed" });
    await expect(getFoodDetail(client, 7)).rejects.not.toThrow(/boom/);
  });
});


/**
 * T9 §4 left `getFoodDetail` awaiting its policy reads one after another: her mark, then the
 * profile, then the refs. They depend on nothing but the revision row, so they go together.
 *
 * The client below answers nothing until every one of the three tables has been ASKED. A
 * sequential path never gets past the first, so it fails on the timeout rather than passing
 * slowly — which is the only way to assert concurrency without a clock.
 */
describe("getFoodDetail's policy reads", () => {
  const REVISION = {
    id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
    category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
    quality_flags: [], catalog_foods: { source: "fdc_sr_legacy" },
    catalog_food_nutrients: [], catalog_portions: [],
    catalog_ingredients: [{ seq: 1, name: "chicken", allergen_tags: [] }],
  };

  function barrierClient(expected: string[]) {
    const asked = new Set<string>();
    let open = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const reached = async () => {
      if (expected.every((t) => asked.has(t))) open();
      await gate;
    };
    const answerFor = (table: string) =>
      table === "catalog_versions" ? { data: { version_label: "fdc-2026-09" }, error: null }
        : table === "catalog_food_revisions" ? { data: REVISION, error: null }
        : table === "constraint_profiles" ? { data: { avoid_food_ref_ids: [] }, error: null }
        : table === "food_refs" ? { data: [], error: null }
        : { data: [], error: null };

    const from = vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      const settle = async () => {
        if (table !== "catalog_versions" && table !== "catalog_food_revisions") {
          asked.add(table);
          await reached();
        }
        return answerFor(table);
      };
      // Every builder method returns the chain; the chain itself is awaitable.
      for (const m of ["select", "eq", "order", "limit", "in", "is", "range"]) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(settle);
      chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        settle().then(onFulfilled, onRejected);
      return chain;
    });
    return { rpc: vi.fn(), from } as never;
  }

  it("asks for her mark, her profile and the refs together", async () => {
    const client = barrierClient(["constraint_profiles", "food_refs", "user_foods"]);
    const detail = await getFoodDetail(client, 7);
    expect(detail.catalogFoodId).toBe(7);
  }, 2000);
});
