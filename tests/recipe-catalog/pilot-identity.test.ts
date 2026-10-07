import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { pilotSrLegacySource, reviewedPilotFoodDbIds }
  from "@/lib/recipe-catalog/pilot-sr-legacy";
import { resolvePilotCatalogRevisions } from "@/lib/server/recipe-pilot-identity";

function clientFor(catalogRows: unknown[], revisionRows: unknown[]) {
  const calls: { table: string; filters: unknown[] }[] = [];
  const client = { from: vi.fn((table: string) => {
    const call = { table, filters: [] as unknown[] };
    calls.push(call);
    const result = { data: table === "catalog_foods" ? catalogRows : revisionRows, error: null };
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((...args: unknown[]) => { call.filters.push(["eq", ...args]); return query; }),
      in: vi.fn((...args: unknown[]) => { call.filters.push(["in", ...args]);
        return Promise.resolve(result); }),
    };
    return query;
  }) } as unknown as SupabaseClient;
  return { client, calls };
}

describe("reviewed pilot USDA identity", () => {
  it("covers exactly the 30 pilot foods with distinct SR Legacy source IDs", () => {
    const used = new Set(pilotRecipes().flatMap((recipe) =>
      recipe.ingredients.map((item) => item.foodDbId).filter((id): id is string => id !== null)));
    expect(new Set(reviewedPilotFoodDbIds())).toEqual(used);
    const keys = [...used].map((id) => pilotSrLegacySource(id));
    expect(keys.every((key) => key?.source === "fdc_sr_legacy")).toBe(true);
    expect(new Set(keys.map((key) => key?.sourceId)).size).toBe(30);
    expect(pilotSrLegacySource("rolled-oats-dry")?.sourceId).toBe("173904");
    expect(pilotSrLegacySource("water")?.sourceId).toBe("174158");
    expect(pilotSrLegacySource("unreviewed-food")).toBeNull();
  });

  it("queries the immutable source key and selects only its active revision", async () => {
    const { client, calls } = clientFor(
      [{ id: 12, source_id: "173904" }, { id: 13, source_id: "174158" }],
      [{ id: 101, catalog_food_id: 12,
        description: pilotSrLegacySource("rolled-oats-dry")!.description }]);
    const mapped = await resolvePilotCatalogRevisions(client,
      ["rolled-oats-dry", "water", "rolled-oats-dry"]);
    expect(mapped.get("rolled-oats-dry")).toEqual({ catalogFoodId: 12, revisionId: 101 });
    expect(mapped.has("water")).toBe(false); // missing active revision stays unknown
    expect(calls).toEqual([
      { table: "catalog_foods", filters: [["eq", "source", "fdc_sr_legacy"],
        ["in", "source_id", ["173904", "174158"]]] },
      { table: "catalog_food_revisions", filters: [["eq", "is_active", true],
        ["in", "catalog_food_id", [12, 13]]] },
    ]);
  });

  it("does not query for unreviewed IDs and does not infer identity from a description", async () => {
    const { client, calls } = clientFor([], []);
    expect(await resolvePilotCatalogRevisions(client, ["unreviewed-food"])).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("refuses a source ID whose active revision has the wrong USDA description", async () => {
    const { client } = clientFor([{ id: 12, source_id: "173904" }],
      [{ id: 101, catalog_food_id: 12, description: "Different food" }]);
    await expect(resolvePilotCatalogRevisions(client, ["rolled-oats-dry"]))
      .rejects.toThrow(/description differs/);
  });
});
