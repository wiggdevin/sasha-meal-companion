/**
 * Review round 2 (sol/BLOCK): `allergenTagsByRevision` (lib/server/catalog.ts) read every
 * `catalog_ingredients` row for a search's revisions with one plain `.in()` select. PostgREST caps
 * a single response at `max_rows` (supabase/config.toml, 1,000) and TRUNCATES the rest WITHOUT an
 * error, so 25 products with a long, split label can together carry more than 1,000 rows — a later
 * allergen row of a split label falls off the truncated tail, and `completenessText` then judges
 * the fragment it DID get as the whole label.
 *
 * The stub mirrors tests/health/health-daily.test.ts's `stubSelect`: an in-memory table with real
 * `(food_revision_id, seq)` ordering and the keyset `.or()` continuation the reader sends, and the
 * `max_rows` cap enforced by default — a paging test that does not enforce the cap proves nothing.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { allergenTagsByRevision } from "@/lib/server/catalog";

type Row = { food_revision_id: number; allergen_tags: string[]; seq: number; raw_text: string | null;
  name: string };

function stubIngredients(rows: Row[], cap = 1000) {
  const query = () => {
    let limit: number | null = null;
    let after: { revisionId: number; seq: number } | null = null;
    let ids: number[] = [];
    const run = () => {
      let out = rows.filter((r) => ids.includes(r.food_revision_id));
      if (after) {
        out = out.filter((r) => r.food_revision_id > after!.revisionId
          || (r.food_revision_id === after!.revisionId && r.seq > after!.seq));
      }
      out = [...out].sort((a, b) => a.food_revision_id - b.food_revision_id || a.seq - b.seq);
      const page = out.slice(0, Math.min(limit ?? cap, cap));
      return { data: page, error: null };
    };
    const q = {
      select: () => q,
      in: (_col: string, values: number[]) => { ids = values; return q; },
      order: () => q,
      limit: (n: number) => { limit = n; return q; },
      or: (filter: string) => {
        const m = /^food_revision_id\.gt\.(\d+),and\(food_revision_id\.eq\.(\d+),seq\.gt\.(\d+)\)$/
          .exec(filter);
        if (!m) throw new Error(`unsupported or() continuation: ${filter}`);
        after = { revisionId: Number(m[2]), seq: Number(m[3]) };
        return q;
      },
      then: <T>(resolve: (value: { data: Row[]; error: null }) => T) =>
        Promise.resolve(run()).then(resolve),
    };
    return q;
  };
  return { from: vi.fn(query) } as unknown as SupabaseClient & { from: ReturnType<typeof vi.fn> };
}

describe("allergenTagsByRevision", () => {
  it("returns every row for a small revision set in one page", async () => {
    const client = stubIngredients([
      { food_revision_id: 1, allergen_tags: ["dairy"], seq: 0, raw_text: null, name: "" },
      { food_revision_id: 1, allergen_tags: [], seq: 1, raw_text: "Milk, salt.", name: "Milk" },
    ]);
    const out = await allergenTagsByRevision(client, [1]);
    expect(out.tags.get(1)).toEqual(["dairy"]);
    expect(client.from.mock.calls.length).toBe(1);
  });

  it("pages past the 1,000-row cap instead of truncating a split label's later allergen row", async () => {
    // One dense revision: 1,250 ingredient rows, its own allergen (peanut) declared only on the
    // LAST row — the row an unpaged, capped read would never reach.
    const dense: Row[] = Array.from({ length: 1249 }, (_, n) => (
      { food_revision_id: 7, allergen_tags: [], seq: n + 1, raw_text: null, name: `Ingredient ${n}` }
    ));
    dense.push({ food_revision_id: 7, allergen_tags: ["peanut"], seq: 1250, raw_text: null,
      name: "Peanut flour" });
    const client = stubIngredients(dense);

    const out = await allergenTagsByRevision(client, [7]);

    expect(client.from.mock.calls.length).toBeGreaterThan(1); // it paged, not truncated
    expect(out.tags.get(7)).toContain("peanut");
    expect(out.names.get(7)).toHaveLength(1250);
  });

  it("keeps a revision set whose row count is exactly the cap", async () => {
    const dense: Row[] = Array.from({ length: 1000 }, (_, n) => (
      { food_revision_id: 3, allergen_tags: n === 999 ? ["soy"] : [], seq: n + 1, raw_text: null,
        name: `Ingredient ${n}` }
    ));
    const out = await allergenTagsByRevision(stubIngredients(dense), [3]);
    expect(out.tags.get(3)).toEqual(["soy"]);
    expect(out.names.get(3)).toHaveLength(1000);
  });

  it("returns nothing, with no query at all, for an empty revision list", async () => {
    const client = stubIngredients([]);
    const out = await allergenTagsByRevision(client, []);
    expect(out.tags.size).toBe(0);
    expect(client.from.mock.calls.length).toBe(0);
  });
});
