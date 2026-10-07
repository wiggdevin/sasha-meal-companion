import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { catalogIngredientsText, catalogWarmFood } =
  await import("@/lib/foods/catalog-ingredients");
const { ensureFacets } = await import("@/lib/foods/facet-warm");
const { inputHash } = await import("@/lib/foods/facet-keys");
const { FACETS } = await import("@/lib/foods/facets");

const systemOneSpy = vi.hoisted(() => vi.fn(async (_state: unknown, questions: unknown,
  _options?: object) => Object.fromEntries(Object.keys(questions as Record<string, unknown>)
  .map((key) => [key, { type: "noul", noul: 0.9 }]))));
vi.mock("@/lib/ai/typesafe", async (original) => ({
  ...(await original<typeof import("@/lib/ai/typesafe")>()),
  systemOne: (p: { state: unknown; questions: unknown; purpose: string }, o?: object) =>
    systemOneSpy(p.state, p.questions, { ...o, purpose: p.purpose }),
}));

function admin() {
  const upsert = vi.fn(async (_rows: unknown) => ({ data: null, error: null }));
  const response = { data: [], error: null };
  const query = {
    eq: vi.fn(), in: vi.fn(), or: vi.fn(), order: vi.fn(), range: vi.fn(),
    then: (resolve: (value: typeof response) => unknown) => Promise.resolve(response).then(resolve),
  };
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  for (const name of ["or", "order", "range"] as const) query[name].mockReturnValue(query);
  return { client: { from: vi.fn(() => ({ select: vi.fn(() => query), upsert })) }, upsert };
}

describe("catalog ingredient mapping", () => {
  it("keeps every row in sequence so a row-two allergen reaches provider state and the hash", async () => {
    const row = {
      id: 21, description: "Trail mix", brand: null, category: "snacks", prep_state: null,
      catalog_ingredients: [
        { seq: 3, name: "salt", raw_text: null },
        { seq: 1, name: "raisins", raw_text: "raisins" },
        { seq: 2, name: "peanuts", raw_text: "peanut pieces" },
      ],
      catalog_portions: [],
    };
    const food = catalogWarmFood(row);
    const db = admin();

    expect(catalogIngredientsText(row.catalog_ingredients)).toBe("raisins, peanut pieces, salt");
    await ensureFacets([food], {
      admin: db.client as never, userId: "accounting-user",
    });

    expect(systemOneSpy.mock.calls[0][0]).toEqual({ foods: [{
      name: "Trail mix", description: "snacks",
      ingredientsText: "raisins, peanut pieces, salt",
    }] });
    const rows = db.upsert.mock.calls[0][0] as unknown as { input_hash: string }[];
    expect(rows).toHaveLength(FACETS.length);
    expect(rows[0].input_hash).toBe(inputHash({
      name: "Trail mix", brand: null, description: "snacks", preparation: null,
      ingredientsText: "raisins, peanut pieces, salt",
    }));
  });

  it("does not let seq 1's own verbatim text double-count against the split tokens that " +
    "follow it (sol finding: a cropped 'Water, sugar' must not read as complete just because " +
    "concatenating it with its own later fragment adds a third comma)", () => {
      // The real write path (supabase/migrations/20261014090000_barcode_write_category.sql):
      // seq 1 carries the FULL verbatim ingredientsText in raw_text, and every row after it
      // carries only its own split fragment in `name`, with no raw_text of its own.
      const row = {
        id: 22, description: "Bad photo", brand: null, category: "snacks", prep_state: null,
        catalog_ingredients: [
          { seq: 1, name: "Water", raw_text: "Water, sugar" },
          { seq: 2, name: "sugar", raw_text: null },
        ],
        catalog_portions: [],
      };
      // "Water, sugar" is a genuine two-item, unterminated (cropped-looking) list on its own —
      // looksLikeCompleteList's own crop guard must still see exactly that text, not
      // "Water, sugar, sugar" (seq 1's raw_text plus seq 2's redundant fragment).
      expect(catalogWarmFood(row).labelComplete).toBe(false);
    });
});
