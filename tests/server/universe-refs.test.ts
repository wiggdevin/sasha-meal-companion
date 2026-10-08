/**
 * lib/server/universe-refs.ts: an open-pool universe row (`universe:<bundled id>`) becomes the
 * account's ordinary catalog ref, through the bundled row's SR Legacy fdcId, with the active
 * revision. A row that cannot be resolved is left out, and a failed read resolves nothing.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbFood } from "@/lib/food-db";
import { universeFoodRefs } from "@/lib/server/universe-refs";

type Rows = { catalog_foods: { id: number; source: string; source_id: string }[];
  catalog_food_revisions: { id: number; catalog_food_id: number; is_active: boolean }[] };

function fakeAdmin(rows: Rows, fail = false) {
  const rpc = vi.fn(async (_name: string, args: { p_catalog_food_id: number }) =>
    ({ data: `00000000-0000-4000-8000-${String(args.p_catalog_food_id).padStart(12, "0")}`, error: null }));
  const from = (table: keyof Rows) => {
    const filters: [string, unknown][] = [];
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
      in: (column: string, values: unknown[]) => { filters.push([column, values]); return query; },
      then: (resolve: (value: unknown) => void) => resolve(fail ? { data: null, error: { code: "57014" } } : {
        data: (rows[table] as Record<string, unknown>[]).filter((row) => filters.every(([column, value]) =>
          Array.isArray(value) ? value.includes(row[column]) : row[column] === value)),
        error: null,
      }),
    };
    return query;
  };
  return { client: { from, rpc } as unknown as SupabaseClient, rpc };
}

const SALMON = "salmon-atlantic-farmed-cooked";
const fdc = String(dbFood(SALMON)!.fdcId);

describe("universeFoodRefs", () => {
  it("mints the catalog ref for a universe row and returns the active revision", async () => {
    const { client, rpc } = fakeAdmin({
      catalog_foods: [{ id: 41, source: "fdc_sr_legacy", source_id: fdc }],
      catalog_food_revisions: [{ id: 900, catalog_food_id: 41, is_active: false }, { id: 901, catalog_food_id: 41, is_active: true }],
    });
    const refs = await universeFoodRefs(client, "u1", [`universe:${SALMON}`, "11111111-1111-4111-8111-111111111111"]);
    expect(refs).toEqual({ [`universe:${SALMON}`]: { foodRefId: "00000000-0000-4000-8000-000000000041", catalogFoodRevisionId: 901 } });
    expect(rpc).toHaveBeenCalledWith("get_or_create_food_ref",
      { p_user_id: "u1", p_kind: "catalog", p_catalog_food_id: 41, p_user_food_id: null });
  });

  it("leaves out a row with no catalog food or no active revision", async () => {
    const { client } = fakeAdmin({ catalog_foods: [{ id: 41, source: "fdc_sr_legacy", source_id: fdc }],
      catalog_food_revisions: [{ id: 900, catalog_food_id: 41, is_active: false }] });
    expect(await universeFoodRefs(client, "u1", [`universe:${SALMON}`, "universe:not-a-bundled-food"])).toEqual({});
  });

  it("resolves nothing when a read fails, and never throws", async () => {
    const { client } = fakeAdmin({ catalog_foods: [], catalog_food_revisions: [] }, true);
    await expect(universeFoodRefs(client, "u1", [`universe:${SALMON}`])).resolves.toEqual({});
  });
});
