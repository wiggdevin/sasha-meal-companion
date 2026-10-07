/**
 * Phase 17 O3 in the O2 snapshot: the facets rung (lib/server/occasion-facets.ts) behind the
 * calibration gate. Shut (the default): nothing is read and the snapshot is the O2 snapshot. Open:
 * a calibrated v2 facet lifts a food the curated table does not know, as source "facets", the hash
 * names the calibration, and the phone carries the score into its ranking evidence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EligibleFoods } from "@/lib/server/eligible-foods";
import type { FacetReadResult } from "@/lib/foods/facets";
import { fakeDb } from "@/tests/helpers/occasion-fake-db";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let eligible: EligibleFoods;
vi.mock("@/lib/server/eligible-foods", () => ({ eligibleFoods: vi.fn(async () => eligible) }));

const { mealSnapshot } = await import("@/lib/server/meal-snapshot");
const { mealEvidence, parseMealSnapshot } = await import("@/lib/meals/snapshot");
const { affinity } = await import("@/lib/meals/affinity");
const { warmFoodCacheKey } = await import("@/lib/foods/facet-keys");
const { facetCacheKey } = await import("@/lib/foods/facets");
const { OCCASION_RUBRIC_VERSION } = await import("@/lib/foods/facet-vocabulary");

const NOW = new Date("2026-10-05T15:00:00Z");
const MOI = { id: "moi", user_id: A, name: "Moi moi", brand: null, ingredients_text: null, rev: 1, deleted_at: null,
  catalog_food_id: null, per_100g: { protein: 7, carbohydrate: 12, fat_total: 5 } };
const EGGS = { ...MOI, id: "eggs", name: "Eggs, whole, cooked", per_100g: { protein: 12.6, carbohydrate: 0.7, fat_total: 9.5 } };
const OPEN = { open: true as const, rubricVersion: OCCASION_RUBRIC_VERSION, calibrationId: "cal-test",
  thresholds: { breakfast: 0.6, lunch: 0.6, dinner: 0.6, snack: 0.6 } };

function account() {
  return fakeDb({
    food_refs: [MOI, EGGS].map((food) => ({ id: `ref-${food.id}`, kind: "user", catalog_food_id: null,
      user_food_id: food.id, user_foods: food })),
    user_foods: [MOI, EGGS],
    user_food_prefs: [MOI, EGGS].map((food) => ({ user_id: A, food_ref_id: `ref-${food.id}`, role: "protein" })),
    user_settings: [{ user_id: A, slot_times: {}, shift_minutes: 0, meals_per_day: 3, time_zone: "UTC" }],
    target_profiles: [], catalog_food_revisions: [], log_entries: [], log_items: [],
  });
}

/** A cache read answering breakfast 0.9 for every food it is asked about (eggs too). */
function cacheAnswering(p: number) {
  return vi.fn(async (keys: readonly { foodKey: string; inputHash: string }[]) => Object.assign(new Map(
    keys.map((key) => [facetCacheKey(key), { breakfast_fit: { p, rubricVersion: 2, judgedAt: NOW.toISOString() } }])),
  { errors: 0 }) as unknown as FacetReadResult);
}

beforeEach(() => {
  eligible = { eligibleRefIds: ["ref-moi", "ref-eggs"], eligibleFoodIds: ["moi", "eggs"], eligibleCatalogFoodIds: [],
    excluded: [], rulesRevision: 1, preferenceFlags: [] };
});

describe("snapshot facets source behind the calibration gate", () => {
  it("shut (default): reads no facet, no source is 'facets', the snapshot is unchanged", async () => {
    const fake = account();
    const body = await mealSnapshot(fake.client, A, NOW);
    expect(fake.queries.some((q) => q.table === "food_facets")).toBe(false);
    expect(JSON.stringify(body.foods)).not.toContain('"facets"');
    expect(body.foods.moi.occasion.breakfast).toEqual({ score: 0.5, source: "neutral" });
  });

  it("open: lifts an unknown food above neutral as 'facets', never a curated one, and names the calibration", async () => {
    const read = cacheAnswering(0.9);
    const shut = await mealSnapshot(account().client, A, NOW);
    const body = await mealSnapshot(account().client, A, NOW, { facets: { gate: OPEN, admin: account().client, readFacets: read } });
    expect(body.foods.moi.occasion.breakfast.source).toBe("facets");
    expect(body.foods.moi.occasion.breakfast.score).toBeGreaterThan(0.5);
    expect(body.foods.moi.occasion.lunch).toEqual({ score: 0.5, source: "neutral" });
    expect(body.foods.eggs.occasion.breakfast).toEqual({ score: 1, source: "curated" });
    expect(body.inputsHash).not.toBe(shut.inputsHash);
    // The cache key is the one the warm job stores the account's own user food under.
    const asked = read.mock.calls[0][0];
    expect(asked).toContainEqual(warmFoodCacheKey({ identity: { kind: "user_food", id: "moi", rev: 1 },
      name: "Moi moi", brand: null, ingredientsText: null }));
  });

  it("an uncertain answer stays neutral even with the gate open", async () => {
    const body = await mealSnapshot(account().client, A, NOW,
      { facets: { gate: OPEN, admin: account().client, readFacets: cacheAnswering(0.5) } });
    expect(body.foods.moi.occasion.breakfast).toEqual({ score: 0.5, source: "neutral" });
  });

  it("the phone parses the 'facets' rows and ranks with them: same answer on both sides", async () => {
    const body = await mealSnapshot(account().client, A, NOW,
      { facets: { gate: OPEN, admin: account().client, readFacets: cacheAnswering(0.9) } });
    const parsed = parseMealSnapshot(JSON.parse(JSON.stringify(body)));
    expect(parsed).not.toBeNull();
    const moi = { id: "moi", name: "Moi moi", role: "protein" as const, unit: "g" as const,
      perUnit: { protein: 0.07, carbs: 0.12, fat: 0.05 }, status: "eats" as const, updatedAt: "" };
    const evidence = mealEvidence(parsed!, [moi], { moi: { userRefId: "ref-moi" } });
    expect(affinity(moi, "breakfast", false, evidence)).toEqual(body.foods.moi.occasion.breakfast);
  });
});
