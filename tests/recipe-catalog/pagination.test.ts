import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchCatalog } from "@/lib/recipe-catalog/repository";

/**
 * `count` published recipes, each with its current revision, plus `superseded` older revisions per
 * recipe that plans may still pin (W038: those never count toward the pilot cap). The roots read
 * honours its `eq`, `not … is null` and `range`; the revisions read honours `in` and `range`.
 */
function catalogClient(count: number, superseded = 0) {
  const revision = (recipe: number, version: number) => ({
    id: `rev-${recipe}-${version}`, recipe_id: `recipe-${recipe}`,
    name: `Dish ${String(recipe).padStart(2, "0")}`,
    cuisine: null, dish_tags: [], active_minutes: 10, total_minutes: 10,
    effort: "minimal", servings: 1, yield_grams: null, yield_status: "unknown",
    min_serving_fraction: 0.5, max_serving_fraction: 2, nutrition_per_serving: {},
  });
  const revisions = Array.from({ length: count }, (_, recipe) =>
    Array.from({ length: superseded + 1 }, (_, version) => revision(recipe, version))).flat();
  const roots = Array.from({ length: count }, (_, recipe) => ({ id: `recipe-${recipe}`,
    current_revision_id: `rev-${recipe}-${superseded}`, publication_state: "published",
    slug: `recipe-${recipe}`, author: "Meal Companion", source_url: null, rights_kind: "original",
    rights_record: "test", source_revision: "v1", kitchen_tested: false, withdrawal_reason: null }));
  const ranges: Record<string, [number, number][]> = {};
  const client = { from(table: string) {
    let ids: string[] | null = null;
    let start = 0; let end = Number.MAX_SAFE_INTEGER;
    const query = {
      select() { return query; }, order() { return query; }, eq() { return query; },
      not() { return query; },
      in(_column: string, values: string[]) { ids = values; return query; },
      range(first: number, last: number) {
        (ranges[table] ??= []).push([first, last]); start = first; end = last; return query;
      },
      then(resolve: (result: { data: unknown[]; error: null }) => void) {
        const pick = <T extends { id: string }>(rows: T[]) => ids === null ? rows
          : rows.filter((row) => ids!.includes(row.id));
        const data = table === "recipe_catalog_revisions" ? pick(revisions).slice(start, end + 1)
          : table === "recipe_catalog" ? pick(roots).slice(start, end + 1)
            : (ids ?? []).map((id) => table === "recipe_catalog_items" ? ({ recipe_revision_id: id,
              seq: 1, name: "Beans", food_ref_id: null, food_revision_id: null,
              food_db_id: "beans", quantity: 1, unit: "g", grams: 1, state: "raw",
              required: true, purchase_grams: 1, purchase_conversion_status: "known",
              nutrition: {}, allergen_evidence: {} })
              : ({ recipe_revision_id: id, seq: 1, instruction: "Serve." }));
        resolve({ data, error: null });
      },
    };
    return query;
  } } as unknown as SupabaseClient;
  return { client, ranges };
}

describe("bounded pilot catalog scan", () => {
  it("reads a viable published row on page two before selection", async () => {
    const { client, ranges } = catalogClient(26);
    const rows = await searchCatalog(client, { query: "", limit: 3 });
    expect(rows).toHaveLength(26);
    expect(rows.at(-1)?.name).toBe("Dish 25");
    expect(ranges.recipe_catalog_revisions).toEqual([[0, 24], [25, 49]]);
  });

  it("fails explicitly when the reviewed 64-recipe pilot cap is exceeded", async () => {
    const { client } = catalogClient(65);
    await expect(searchCatalog(client, { query: "" }))
      .rejects.toMatchObject({ status: 503, code: "recipe_catalog_cap" });
  });

  it("counts current published revisions only: 24 recipes with 3 old revisions each still load", async () => {
    const { client } = catalogClient(24, 3);
    const rows = await searchCatalog(client, { query: "" });
    expect(rows).toHaveLength(24);
    expect(rows.every((row) => row.revisionId.endsWith("-3"))).toBe(true);
  });

  it("allows exactly 64 published recipes", async () => {
    const { client } = catalogClient(64, 1);
    await expect(searchCatalog(client, { query: "" })).resolves.toHaveLength(64);
  });
});
