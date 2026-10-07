import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { warmFoodCacheKey } = await import("@/lib/foods/facet-keys");
const { catalogWarmFood } = await import("@/lib/foods/catalog-ingredients");
const { OCCASION_RUBRIC_VERSION, RUBRIC_VERSION } = await import("@/lib/foods/facet-vocabulary");
const { occasionFacetEvidence } = await import("@/lib/server/occasion-facets");
const { withFacetPrior } = await import("@/lib/meals/facet-affinity");
const { affinity } = await import("@/lib/meals/affinity");

type Row = Record<string, unknown>;

/** A fake PostgREST client: `.in()` and `.eq()` filter rows; `.or()` and `.select()` pass through. */
function fakeDb(tables: Record<string, Row[]>) {
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    let rows = [...(tables[table] ?? [])];
    const chain: Record<string, unknown> = {
      select: () => chain,
      or: () => chain,
      order: () => chain,
      range: () => chain,
      eq: (column: string, value: unknown) => { rows = rows.filter((row) => row[column] === value); return chain; },
      is: (column: string, value: unknown) => { rows = rows.filter((row) => (row[column] ?? null) === value); return chain; },
      in: (column: string, values: unknown[]) => { rows = rows.filter((row) => values.includes(row[column])); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return chain;
  };
  return { client: { from } as unknown as SupabaseClient, reads };
}

const OPEN = { open: true as const, rubricVersion: OCCASION_RUBRIC_VERSION, calibrationId: "cal-1",
  thresholds: { breakfast: 0.6, lunch: 0.5, dinner: 0.5, snack: 0.7 } };

const USER_FOOD = { id: "food-1", kind: "user_food" as const, userFoodId: "food-1" };
const USER_FOOD_ROW = { id: "food-1", user_id: "user-a", rev: 3, name: "Moi moi", brand: null,
  ingredients_text: "black-eyed peas, pepper, onion", deleted_at: null };
const CATALOG_FOOD = { id: "catalog:77", kind: "catalog" as const, catalogFoodId: 77 };
const REVISION = { id: 9001, description: "Congee, plain", brand: null, category: "Cereal Grains",
  prep_state: "cooked", catalog_ingredients: [], catalog_portions: [] };

function facetRows(key: { foodKey: string; inputHash: string }, version: number, p: Record<string, number>): Row[] {
  return Object.entries(p).map(([facet, value]) => ({ food_key: key.foodKey, input_hash: key.inputHash, facet,
    rubric_version: version, p: value, judged_at: "2026-10-05T00:00:00.000Z" }));
}

const userKey = warmFoodCacheKey({ identity: { kind: "user_food", id: "food-1", rev: 3 }, name: USER_FOOD_ROW.name,
  brand: null, ingredientsText: USER_FOOD_ROW.ingredients_text });
const catalogKey = warmFoodCacheKey(catalogWarmFood(REVISION));

describe("occasionFacetEvidence: the snapshot's facets source", () => {
  it("abstains without touching the database while the calibration gate is shut", async () => {
    const db = fakeDb({});
    const result = await occasionFacetEvidence(db.client, "user-a", [USER_FOOD, CATALOG_FOOD],
      { gate: { open: false, reason: "no stored calibration report" } });
    expect(result).toEqual({ status: "abstain", reason: "no stored calibration report", hashPart: "abstain",
      scores: {}, errors: 0 });
    expect(db.reads).toEqual([]);
  });

  it("abstains by default (no stored calibration)", async () => {
    const db = fakeDb({});
    const result = await occasionFacetEvidence(db.client, "user-a", [USER_FOOD]);
    expect(result.status).toBe("abstain");
    expect(db.reads).toEqual([]);
  });

  it("maps v2 rows above the threshold to scores and abstains below it", async () => {
    const db = fakeDb({
      food_facets: [
        ...facetRows(userKey, OCCASION_RUBRIC_VERSION, { breakfast_fit: 0.8, lunch_fit: 0.9, dinner_fit: 0.3, snack_fit: 0.2 }),
        ...facetRows(catalogKey, OCCASION_RUBRIC_VERSION, { breakfast_fit: 0.95, lunch_fit: 0.1, dinner_fit: 0.1, snack_fit: 0.1 }),
      ],
      catalog_food_revisions: [REVISION],
      user_foods: [USER_FOOD_ROW],
    });
    const result = await occasionFacetEvidence(db.client, "user-a", [USER_FOOD, CATALOG_FOOD], {
      gate: OPEN, activeRevisionsByFood: async () => new Map([[77, [9001]]]),
    });
    expect(result.status).toBe("open");
    expect(result.hashPart).toBe("facets:cal-1");
    expect(result.errors).toBe(0);
    expect(Object.keys(result.scores["food-1"]).sort()).toEqual(["breakfast", "lunch"]);
    expect(result.scores["food-1"].breakfast).toBeGreaterThan(0.5);
    expect(Object.keys(result.scores["catalog:77"])).toEqual(["breakfast"]);
  });

  it("never reads a v1 occasion row as a v2 judgment (re-warmed, not reinterpreted)", async () => {
    const db = fakeDb({
      user_foods: [USER_FOOD_ROW],
      food_facets: facetRows(userKey, RUBRIC_VERSION, { breakfast_fit: 0.99, lunch_fit: 0.99, dinner_fit: 0.99, snack_fit: 0.99 }),
    });
    const result = await occasionFacetEvidence(db.client, "user-a", [USER_FOOD], { gate: OPEN });
    expect(result.scores).toEqual({});
  });

  it("ignores rows for another input (an edited food has a new key) and abstains for unresolved foods", async () => {
    const stale = { ...userKey, inputHash: `\\x${"0".repeat(64)}` };
    const db = fakeDb({ user_foods: [USER_FOOD_ROW],
      food_facets: facetRows(stale, OCCASION_RUBRIC_VERSION, { breakfast_fit: 0.99 }) });
    const result = await occasionFacetEvidence(db.client, "user-a", [USER_FOOD, CATALOG_FOOD], {
      gate: OPEN, activeRevisionsByFood: async () => new Map(),
    });
    expect(result.scores).toEqual({});
  });

  it("feeds the ladder below curated: a facet lifts only a food curated does not know", async () => {
    const db = fakeDb({ user_foods: [USER_FOOD_ROW],
      food_facets: facetRows(userKey, OCCASION_RUBRIC_VERSION, { breakfast_fit: 0.8 }) });
    const { scores } = await occasionFacetEvidence(db.client, "user-a", [USER_FOOD], { gate: OPEN });
    const moiMoi = { id: "food-1", name: "Moi moi", role: "protein" as const, unit: "g" as const,
      perUnit: { protein: 0.07, carbs: 0.1, fat: 0.03 }, status: "eats" as const, updatedAt: "" };
    const lifted = withFacetPrior(affinity(moiMoi, "breakfast"), scores["food-1"]?.breakfast, "breakfast");
    expect(lifted.source).toBe("facets");
    const tuna = { ...moiMoi, id: "tuna", name: "Tuna, canned in water" };
    expect(withFacetPrior(affinity(tuna, "breakfast"), 0.85, "breakfast").source).toBe("curated");
  });

  it("gives no evidence for a user food the account does not own, or one that is deleted", async () => {
    const rows = facetRows(userKey, OCCASION_RUBRIC_VERSION, { breakfast_fit: 0.9 });
    const other = fakeDb({ user_foods: [USER_FOOD_ROW], food_facets: rows });
    expect((await occasionFacetEvidence(other.client, "user-b", [USER_FOOD], { gate: OPEN })).scores).toEqual({});
    const deleted = fakeDb({ user_foods: [{ ...USER_FOOD_ROW, deleted_at: "2026-10-01" }], food_facets: rows });
    expect((await occasionFacetEvidence(deleted.client, "user-a", [USER_FOOD], { gate: OPEN })).scores).toEqual({});
  });

  it("counts a failed catalog read as an error and abstains for those foods", async () => {
    const db = fakeDb({});
    const result = await occasionFacetEvidence(db.client, "user-a", [CATALOG_FOOD], {
      gate: OPEN, activeRevisionsByFood: async () => { throw new Error("db down"); },
    });
    expect(result).toMatchObject({ status: "open", scores: {}, errors: 1 });
  });
});
