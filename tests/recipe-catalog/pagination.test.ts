import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchCatalog } from "@/lib/recipe-catalog/repository";

function catalogClient(count: number) {
  const revisions = Array.from({ length: count }, (_, index) => ({
    id: `rev-${index}`, recipe_id: `recipe-${index}`, name: `Dish ${String(index).padStart(2, "0")}`,
    cuisine: null, dish_tags: [], active_minutes: 10, total_minutes: 10,
    effort: "minimal", servings: 1, yield_grams: null, yield_status: "unknown",
    min_serving_fraction: 0.5, max_serving_fraction: 2, nutrition_per_serving: {},
  }));
  const ranges: [number, number][] = [];
  const client = { from(table: string) {
    let ids: string[] = [];
    let start = 0; let end = count;
    const query = {
      select() { return query; }, order() { return query; },
      in(_column: string, values: string[]) { ids = values; return query; },
      range(first: number, last: number) {
        ranges.push([first, last]); start = first; end = last; return query;
      },
      then(resolve: (result: { data: unknown[]; error: null }) => void) {
        const data = table === "recipe_catalog_revisions" ? revisions.slice(start, end + 1)
          : table === "recipe_catalog" ? ids.map((id) => ({ id,
            current_revision_id: `rev-${id.slice(7)}`, publication_state: "published",
            slug: id, author: "Meal Companion", source_url: null, rights_kind: "original",
            rights_record: "test", source_revision: "v1", kitchen_tested: false,
            withdrawal_reason: null }))
            : ids.map((id) => table === "recipe_catalog_items" ? ({ recipe_revision_id: id,
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
    expect(ranges).toEqual([[0, 24], [25, 49]]);
  });

  it("fails explicitly when the reviewed 64-row pilot cap is exceeded", async () => {
    const { client } = catalogClient(65);
    await expect(searchCatalog(client, { query: "" }))
      .rejects.toMatchObject({ status: 503, code: "recipe_catalog_cap" });
  });
});
