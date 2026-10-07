import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendRevision, planRepair, type Snapshot }
  from "@/scripts/repair-recipe-food-mapping";
import { warmOptions, runPilotWarm } from "@/scripts/warm-pilot-recipe-facets";
import { reviewedPilotFoodDbIds, pilotSrLegacySource }
  from "@/lib/recipe-catalog/pilot-sr-legacy";

const local = { SUPABASE_TEST_URL: "http://127.0.0.1:54321",
  SUPABASE_TEST_SERVICE_ROLE_KEY: "test-key" };

function state(): Snapshot {
  return {
    roots: [{ id: "root", slug: "banana-yogurt-overnight-oats",
      source_revision: "original-pilot-v1", publication_state: "published",
      current_revision_id: "old" }],
    revisions: [{ id: "old", recipe_id: "root", rev: 1, name: "Oats", cuisine: null,
      dish_tags: [], active_minutes: 1, total_minutes: 2, effort: "none", servings: 2,
      yield_grams: null, yield_status: "unknown", min_serving_fraction: 0.5,
      max_serving_fraction: 2, nutrition_per_serving: {} }],
    items: [{ recipe_revision_id: "old", seq: 1, name: "Banana", food_ref_id: null,
      food_revision_id: null, food_db_id: "banana", quantity: 1, unit: "g", grams: 100,
      state: "raw", required: true, purchase_grams: 100,
      purchase_conversion_status: "known", nutrition: { kcal: 89 }, allergen_evidence: {} }],
    steps: [{ recipe_revision_id: "old", seq: 1, instruction: "Slice the banana." }],
    seals: new Set(),
    identities: new Map([["banana", { catalogFoodId: 10, revisionId: 20 }]]),
    refs: new Map([[10, "ref-10"]]),
  };
}

describe("append-only pilot mapping repair", () => {
  it("plans only missing identities and refuses a conflicting sealed identity", () => {
    const snapshot = state();
    expect(planRepair(snapshot)).toMatchObject({ repairs: [{ missing: 1 }],
      missingCatalog: [], missingRefs: [], alreadyMapped: 0 });
    snapshot.items[0].food_ref_id = "ref-10";
    snapshot.items[0].food_revision_id = 20;
    expect(planRepair(snapshot)).toMatchObject({ repairs: [], alreadyMapped: 1 });
    snapshot.items[0].food_revision_id = 999;
    expect(() => planRepair(snapshot)).toThrow(/conflicting catalog revision/);
  });

  it("resumes one unsealed partial append and refuses inconsistent pending content", () => {
    const snapshot = state();
    snapshot.revisions.push({ ...snapshot.revisions[0], id: "orphan", rev: 2 });
    expect(planRepair(snapshot).repairs[0].pending).toMatchObject({
      revision: { id: "orphan" }, hasItems: false, hasSteps: false,
    });
    snapshot.items.push({ ...snapshot.items[0], recipe_revision_id: "orphan",
      food_ref_id: "ref-10", food_revision_id: 20 });
    expect(planRepair(snapshot).repairs[0].pending).toMatchObject({ hasItems: true, hasSteps: false });
    snapshot.items.at(-1)!.name = "Different banana";
    expect(() => planRepair(snapshot)).toThrow(/inconsistent pending items/);
    snapshot.items.at(-1)!.name = "Banana";
    snapshot.seals.add("orphan");
    expect(() => planRepair(snapshot)).toThrow(/sealed or inconsistent pending revision/);
  });

  it("copies the old contents to a new revision before switching the root", async () => {
    const snapshot = state();
    const writes: { table: string; kind: string; body: unknown }[] = [];
    const client = { from: (table: string) => ({
      insert: (body: unknown) => {
        writes.push({ table, kind: "insert", body });
        const result = { data: null, error: null };
        return { ...result, select: () => ({ single: async () =>
          ({ data: { id: "new" }, error: null }) }) };
      },
      update: (body: unknown) => {
        writes.push({ table, kind: "update", body });
        const q = { eq: () => q, select: async () => ({ data: [{ id: "root" }], error: null }) };
        return q;
      },
    }) } as unknown as SupabaseClient;
    await appendRevision(client, planRepair(snapshot).repairs[0], snapshot);
    expect(writes.map((row) => `${row.table}:${row.kind}`)).toEqual([
      "recipe_catalog_revisions:insert", "recipe_catalog_items:insert",
      "recipe_catalog_steps:insert", "recipe_catalog:update",
    ]);
    expect(writes[1].body).toEqual([expect.objectContaining({ recipe_revision_id: "new",
      food_db_id: "banana", food_ref_id: "ref-10", food_revision_id: 20,
      nutrition: { kcal: 89 } })]);
    expect(writes[3].body).toEqual({ current_revision_id: "new" });
    expect(snapshot.items[0].food_revision_id).toBeNull(); // old sealed row was not mutated
  });

  it("reuses a complete unsealed pending revision and only switches the root", async () => {
    const snapshot = state();
    snapshot.revisions.push({ ...snapshot.revisions[0], id: "orphan", rev: 2 });
    snapshot.items.push({ ...snapshot.items[0], recipe_revision_id: "orphan",
      food_ref_id: "ref-10", food_revision_id: 20 });
    snapshot.steps.push({ ...snapshot.steps[0], recipe_revision_id: "orphan" });
    const writes: string[] = [];
    const client = { from: (table: string) => ({ update: () => {
      writes.push(table);
      const q = { eq: () => q, select: async () => ({ data: [{ id: "root" }], error: null }) };
      return q;
    }, insert: () => { throw new Error(`Unexpected ${table} insert`); } }) } as unknown as SupabaseClient;
    await appendRevision(client, planRepair(snapshot).repairs[0], snapshot);
    expect(writes).toEqual(["recipe_catalog"]);
  });
});

describe("targeted facet warm", () => {
  it("defaults to a read-only local target and requires explicit production confirmation", () => {
    expect(warmOptions([], local)).toMatchObject({ commit: false,
      target: { mode: "local" } });
    expect(() => warmOptions(["--commit"], local)).toThrow(/accounting/);
    expect(() => warmOptions(["--production", "--commit", "--user-id=00000000-0000-4000-8000-000000000001"], {
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-key", SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
    })).toThrow(/exact --confirm-project-ref/);
  });

  it("warms exactly the 30 reviewed active revisions through the existing lifecycle", async () => {
    const ids = reviewedPilotFoodDbIds();
    const foods = ids.map((id, index) => ({ id: index + 1,
      source_id: pilotSrLegacySource(id)!.sourceId }));
    const revisions = foods.map((row, index) => ({ id: row.id + 100,
      catalog_food_id: row.id, description: pilotSrLegacySource(ids[index])!.description }));
    const client = { from: (table: string) => {
      const query = { select: () => query, eq: () => query,
        in: async () => ({ data: table === "catalog_foods" ? foods : revisions, error: null }) };
      return query;
    } } as unknown as SupabaseClient;
    const warm = vi.fn(async () => ({ foods: 30, judged: 0, skipped: 0,
      unknown: 30, writes: 0, errors: 0, retryableUnknown: 0 }));
    const result = await runPilotWarm([], local, { client, warm });
    expect(result).toMatchObject({ mapped: 30, missing: [], dryRun: true, writes: 0 });
    expect(warm).toHaveBeenCalledWith(revisions.map((row) => row.id),
      { admin: client, userId: undefined, dryRun: true });
  });
});
