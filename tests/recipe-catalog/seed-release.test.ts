import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pilotManifest, preflightPilotCatalog, seedPilotCatalog } from "@/lib/server/recipe-catalog-seed";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";

const clientHolder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => clientHolder.client }));
import { resolveSeedTarget, runSeed } from "@/scripts/seed-recipe-catalog";

type Row = Record<string, unknown>;
function fakeClient(initial: Row[] = [], failOnceAt?: string) {
  const tables: Record<string, Row[]> = {
    recipe_catalog: [...initial], recipe_catalog_revisions: [], recipe_catalog_items: [],
    recipe_catalog_steps: [], catalog_foods: [], catalog_food_revisions: [], food_refs: [],
  };
  const writes: string[] = [];
  let nextId = 1;
  function from(table: string) {
    const filters: ((row: Row) => boolean)[] = [];
    let limitCount = Infinity;
    let action: "read" | "insert" | "update" = "read";
    let payload: Row | Row[] = {};
    const matching = () => tables[table].filter((row) => filters.every((filter) => filter(row)));
    const execute = () => {
      if (action === "read") return { data: matching().slice(0, limitCount), error: null };
      writes.push(`${table}:${action}`);
      if (failOnceAt === `${table}:${action}`) {
        failOnceAt = undefined;
        return { data: [] as Row[], error: new Error("injected write failure") };
      }
      if (action === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((row) => ({
          ...row, id: row.id ?? `id-${nextId++}`,
        }));
        tables[table].push(...rows);
        return { data: rows, error: null };
      }
      const rows = matching();
      for (const row of rows) Object.assign(row, payload);
      return { data: rows, error: null };
    };
    const query = {
      select: (_columns: string) => query,
      eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return query; },
      in: (key: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[key])); return query;
      },
      limit: (count: number) => { limitCount = count; return query; },
      insert: (body: Row | Row[]) => { action = "insert"; payload = body; return query; },
      update: (body: Row) => { action = "update"; payload = body; return query; },
      maybeSingle: async () => {
        const result = execute();
        return { data: result.data[0] ?? null, error: result.error };
      },
      single: async () => {
        const result = execute();
        return { data: result.data[0] ?? null, error: result.error };
      },
      then: (resolve: (value: { data: Row[]; error: Error | null }) => void) =>
        Promise.resolve(execute()).then(resolve),
    };
    return query;
  }
  return { client: { from } as unknown as SupabaseClient, tables, writes };
}

const productionEnv = {
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "secret-placeholder",
  SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
};

beforeEach(() => { clientHolder.client = null; });

describe("pilot seed release guard", () => {
  it("requires an exact confirmed ref on the configured production origin", () => {
    const args = ["--production", "--write", "--confirm-project-ref=abcdefghijklmnopqrst"];
    expect(resolveSeedTarget(args, productionEnv)).toMatchObject({ mode: "production" });
    expect(resolveSeedTarget(args, productionEnv)).not.toHaveProperty("key");
    expect(() => resolveSeedTarget(args.slice(0, 2), productionEnv)).toThrow(/exact/);
    expect(() => resolveSeedTarget([...args, args[2]], productionEnv)).toThrow(/exact/);
    expect(() => resolveSeedTarget(args, { ...productionEnv,
      SUPABASE_URL: "https://differentprojectref.supabase.co" })).toThrow(/exact/);
    expect(() => resolveSeedTarget(args, { ...productionEnv,
      SUPABASE_URL: "http://abcdefghijklmnopqrst.supabase.co" })).toThrow(/exact/);
    expect(() => resolveSeedTarget(["--write"], {
      SUPABASE_TEST_URL: productionEnv.SUPABASE_URL,
      SUPABASE_TEST_SERVICE_ROLE_KEY: "secret-placeholder",
    })).toThrow(/loopback/);
  });

  it("reports reviewed source counts and dry-runs without writes", async () => {
    expect(pilotManifest()).toMatchObject({ recipes: 24, ingredientLines: 119, foodDbIds: 30 });
    const fake = fakeClient();
    clientHolder.client = fake.client;
    const env = { SUPABASE_TEST_URL: "http://127.0.0.1:54321",
      SUPABASE_TEST_SERVICE_ROLE_KEY: "secret-placeholder" };
    expect(await runSeed([], env)).toContain("No database request made");
    expect(await runSeed(["--dry-run"], env)).toContain(`${pilotRecipes().length} to create`);
    expect(fake.writes).toEqual([]);
    expect(fake.tables.recipe_catalog).toEqual([]);
  });

  it("keeps a missing credential behind the admin boundary before any database request", async () => {
    const fake = fakeClient();
    clientHolder.client = fake.client;
    await expect(runSeed(["--production", "--dry-run",
      "--confirm-project-ref=abcdefghijklmnopqrst"], {
      ...productionEnv, SUPABASE_SERVICE_ROLE_KEY: undefined,
    })).rejects.toThrow(/service key is missing/);
    expect(fake.writes).toEqual([]);
  });

  it("keeps published and withdrawn rows untouched", async () => {
    const [a, b] = pilotRecipes();
    const fake = fakeClient([
      { id: "published-id", slug: a.recipeId, publication_state: "published", author: "Earlier author" },
      { id: "withdrawn-id", slug: b.recipeId, publication_state: "withdrawn", withdrawal_reason: "Rights" },
    ]);
    const originals = structuredClone(fake.tables.recipe_catalog);
    const preflight = await preflightPilotCatalog(fake.client);
    expect(preflight).toMatchObject({ toCreate: pilotRecipes().length - 2, skipped: 2 });
    expect(fake.tables.recipe_catalog).toEqual(originals);
    expect(fake.writes).toEqual([]);
  });

  it("stops on an incomplete draft instead of silently skipping it", async () => {
    const recipe = pilotRecipes()[0];
    const fake = fakeClient([{ id: "partial-id", slug: recipe.recipeId,
      publication_state: "draft", author: recipe.source.author,
      source_url: recipe.source.sourceUrl, rights_kind: recipe.source.rightsKind,
      rights_record: recipe.source.rightsRecord, source_revision: recipe.source.sourceRevision,
      kitchen_tested: recipe.source.kitchenTested }]);
    await expect(preflightPilotCatalog(fake.client)).rejects.toThrow(/provenance matches, 0 revisions, 0\/6 items, 0\/3 steps/);
    await expect(seedPilotCatalog(fake.client)).rejects.toThrow(/Unpublished pilot draft/);
    expect(fake.writes).toEqual([]);
  });

  it("diagnoses a failed partial insert on the next attempt", async () => {
    const fake = fakeClient([], "recipe_catalog_steps:insert");
    await expect(seedPilotCatalog(fake.client)).rejects.toThrow(/Could not create pilot steps/);
    expect(fake.tables.recipe_catalog[0].publication_state).toBe("draft");
    expect(fake.tables.recipe_catalog_revisions).toHaveLength(1);
    expect(fake.tables.recipe_catalog_items).toHaveLength(6);
    const firstWrites = fake.writes.length;
    await expect(seedPilotCatalog(fake.client)).rejects.toThrow(/1 revisions, 6\/6 items, 0\/3 steps/);
    expect(fake.writes).toHaveLength(firstWrites);
  });

  it("creates a complete pilot once and skips every row on repeat", async () => {
    const fake = fakeClient();
    expect(await seedPilotCatalog(fake.client)).toEqual({ created: pilotManifest().recipes, skipped: 0 });
    expect(fake.tables.recipe_catalog_revisions).toHaveLength(pilotManifest().recipes);
    expect(fake.tables.recipe_catalog_items).toHaveLength(pilotManifest().ingredientLines);
    expect(fake.tables.recipe_catalog_steps.length).toBe(pilotManifest().steps);
    expect(fake.tables.recipe_catalog.every((row) => row.publication_state === "published")).toBe(true);
    const firstWrites = fake.writes.length;
    expect(await seedPilotCatalog(fake.client)).toEqual({ created: 0, skipped: pilotManifest().recipes });
    expect(fake.writes).toHaveLength(firstWrites);
  });

  it("seeds the reviewed USDA source identity despite a duplicate description", async () => {
    const fake = fakeClient();
    fake.tables.catalog_foods.push({ id: 100, source: "fdc_sr_legacy", source_id: "173944" },
      { id: 101, source: "fdc_foundation", source_id: "different" });
    fake.tables.catalog_food_revisions.push({ id: 200, catalog_food_id: 100,
      description: "Bananas, raw", is_active: true },
    { id: 201, catalog_food_id: 101, description: "Bananas, raw", is_active: true });
    fake.tables.food_refs.push({ id: "ref-100", kind: "catalog", catalog_food_id: 100 });
    await seedPilotCatalog(fake.client);
    const bananas = fake.tables.recipe_catalog_items.filter((row) => row.food_db_id === "banana");
    expect(bananas.length).toBeGreaterThan(0);
    expect(bananas.every((row) => row.food_revision_id === 200
      && row.food_ref_id === "ref-100")).toBe(true);
  });
});
