import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  ensureCatalogRevisionFacets: vi.fn(),
  ensureUserFoodFacets: vi.fn(),
  activeRevisionsByFood: vi.fn(),
}));

vi.mock("@/lib/foods/facet-warm", () => ({
  ensureCatalogRevisionFacets: mocks.ensureCatalogRevisionFacets,
  ensureUserFoodFacets: mocks.ensureUserFoodFacets,
}));
vi.mock("@/lib/server/log-evidence", () => ({
  activeRevisionsByFood: mocks.activeRevisionsByFood,
}));

const { warmEatsFacets } = await import("./eats-facet-warm");
const { warmFoodCacheKey } = await import("@/lib/foods/facet-keys");
const { catalogWarmFood } = await import("@/lib/foods/catalog-ingredients");

/** A catalog revision row as the warm job reads it, and the input hash it stores facets under. */
const revision = (id: number) => ({ id, description: `Food ${id}`, brand: null, category: "Cereal Grains",
  prep_state: null, catalog_ingredients: [], catalog_portions: [] });
const hashOf = (id: number) => warmFoodCacheKey(catalogWarmFood(revision(id))).inputHash;
const OLD_HASH = `\\x${"0".repeat(64)}`;
const OCCASION = ["breakfast_fit", "lunch_fit", "dinner_fit", "snack_fit"];

/** A no-op facet result: nothing judged, nothing wrong. */
function okResult(judged = 0) {
  return { foods: 0, judged, skipped: 0, unknown: 0, writes: judged, errors: 0, batches: [],
    retryableUnknown: 0, nonRetryable: [] };
}
function errorResult() {
  return { foods: 0, judged: 0, skipped: 0, unknown: 0, writes: 0, errors: 1, batches: [],
    retryableUnknown: 1, nonRetryable: [] };
}

type Row = Record<string, unknown>;

/** A minimal thenable query-builder: every chain method returns itself, and awaiting it resolves
 *  to the table's canned {data, error}. Good enough for the handful of straight-line reads
 *  warmEatsFacets makes — no joins, no OR filters. */
function fakeClient(responses: Record<string, { data: Row[] | null; error: unknown }>) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  function builder(table: string) {
    const response = responses[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "eq", "in", "is", "order", "range"]) {
      chain[op] = (...args: unknown[]) => { calls.push({ table, op, args }); return chain; };
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(response).then(resolve, reject);
    return chain;
  }
  return { from: (table: string) => builder(table), calls };
}

const PREFS = (refIds: string[]) => ({ data: refIds.map((id) => ({ food_ref_id: id })), error: null });
const REFS = (rows: Row[]) => ({ data: rows, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeRevisionsByFood.mockResolvedValue(new Map());
  mocks.ensureCatalogRevisionFacets.mockResolvedValue(okResult());
  mocks.ensureUserFoodFacets.mockResolvedValue(okResult());
});

describe("warmEatsFacets", () => {
  it("does nothing for an empty Eats list", async () => {
    const client = fakeClient({ user_food_prefs: PREFS([]) });
    const result = await warmEatsFacets(client as never, "user-1");
    expect(result).toEqual({ foods: 0, warmed: 0, skipped: 0, errors: 0, stoppedEarly: false });
    expect(mocks.ensureCatalogRevisionFacets).not.toHaveBeenCalled();
    expect(mocks.ensureUserFoodFacets).not.toHaveBeenCalled();
  });

  it("warms an uncached catalog food and an uncached user food, charged to the caller", async () => {
    mocks.activeRevisionsByFood.mockResolvedValue(new Map([[501, [9001]]]));
    mocks.ensureCatalogRevisionFacets.mockResolvedValue(okResult(26));
    mocks.ensureUserFoodFacets.mockResolvedValue(okResult(26));
    const client = fakeClient({
      user_food_prefs: PREFS(["ref-catalog", "ref-user"]),
      food_refs: REFS([
        { id: "ref-catalog", kind: "catalog", user_food_id: null, catalog_food_id: 501 },
        { id: "ref-user", kind: "user", user_food_id: "food-7", catalog_food_id: null },
      ]),
      user_foods: { data: [{ id: "food-7", rev: 2 }], error: null },
      food_facets: { data: [], error: null },
    });

    const result = await warmEatsFacets(client as never, "user-1", { maxFoods: 40 });

    expect(mocks.ensureCatalogRevisionFacets).toHaveBeenCalledWith([9001],
      expect.objectContaining({ userId: "user-1" }));
    expect(mocks.ensureUserFoodFacets).toHaveBeenCalledWith(["food-7"],
      expect.objectContaining({ userId: "user-1" }));
    expect(result).toEqual({ foods: 2, warmed: 52, skipped: 0, errors: 0, stoppedEarly: false });
  });

  it("skips a food already warm at the current rubrics, without paying for it", async () => {
    mocks.activeRevisionsByFood.mockResolvedValue(new Map([[501, [9001]]]));
    const client = fakeClient({
      user_food_prefs: PREFS(["ref-catalog"]),
      food_refs: REFS([
        { id: "ref-catalog", kind: "catalog", user_food_id: null, catalog_food_id: 501 },
      ]),
      catalog_food_revisions: { data: [revision(9001)], error: null },
      food_facets: { data: [
        { food_key: "catalog_revision:9001", input_hash: hashOf(9001), facet: "human_food", rubric_version: 1 },
        ...OCCASION.map((facet) =>
          ({ food_key: "catalog_revision:9001", input_hash: hashOf(9001), facet, rubric_version: 2 })),
      ], error: null },
    });

    const result = await warmEatsFacets(client as never, "user-1");

    expect(mocks.ensureCatalogRevisionFacets).not.toHaveBeenCalled();
    expect(mocks.ensureUserFoodFacets).not.toHaveBeenCalled();
    expect(result).toEqual({ foods: 1, warmed: 0, skipped: 1, errors: 0, stoppedEarly: false });
  });

  it("re-warms a food warmed before the v2 occasion rubric, after the never-warmed foods", async () => {
    mocks.activeRevisionsByFood.mockResolvedValue(new Map([[1, [101]], [2, [102]]]));
    const client = fakeClient({
      user_food_prefs: PREFS(["r1", "r2"]),
      food_refs: REFS([
        { id: "r1", kind: "catalog", user_food_id: null, catalog_food_id: 1 },
        { id: "r2", kind: "catalog", user_food_id: null, catalog_food_id: 2 },
      ]),
      // 101 was warmed under rubric v1 for everything (its v1 breakfast_fit does not count);
      // 102 was never warmed.
      catalog_food_revisions: { data: [revision(101), revision(102)], error: null },
      food_facets: { data: [
        { food_key: "catalog_revision:101", input_hash: hashOf(101), facet: "human_food", rubric_version: 1 },
        { food_key: "catalog_revision:101", input_hash: hashOf(101), facet: "breakfast_fit", rubric_version: 1 },
      ], error: null },
    });

    const result = await warmEatsFacets(client as never, "user-1", { maxFoods: 1 });

    expect(mocks.ensureCatalogRevisionFacets).toHaveBeenCalledWith([102], expect.anything());
    expect(result).toMatchObject({ foods: 2, skipped: 1 });

    await warmEatsFacets(client as never, "user-1", { maxFoods: 2 });
    expect(mocks.ensureCatalogRevisionFacets).toHaveBeenLastCalledWith([102, 101], expect.anything());
  });

  it("re-warms a food whose occasion sentinels were judged for an older input (round-2 BLOCK 2)", async () => {
    mocks.activeRevisionsByFood.mockResolvedValue(new Map([[501, [9001]]]));
    const client = fakeClient({
      user_food_prefs: PREFS(["ref-catalog"]),
      food_refs: REFS([{ id: "ref-catalog", kind: "catalog", user_food_id: null, catalog_food_id: 501 }]),
      catalog_food_revisions: { data: [revision(9001)], error: null },
      food_facets: { data: [
        { food_key: "catalog_revision:9001", input_hash: hashOf(9001), facet: "human_food", rubric_version: 1 },
        ...OCCASION.map((facet) =>
          ({ food_key: "catalog_revision:9001", input_hash: OLD_HASH, facet, rubric_version: 2 })),
      ], error: null },
    });

    const result = await warmEatsFacets(client as never, "user-1");

    expect(mocks.ensureCatalogRevisionFacets).toHaveBeenCalledWith([9001], expect.anything());
    expect(result).toMatchObject({ foods: 1, skipped: 0 });
  });

  it("counts nothing as warm and warms nothing when the revision read fails", async () => {
    mocks.activeRevisionsByFood.mockResolvedValue(new Map([[501, [9001]]]));
    const client = fakeClient({
      user_food_prefs: PREFS(["ref-catalog"]),
      food_refs: REFS([{ id: "ref-catalog", kind: "catalog", user_food_id: null, catalog_food_id: 501 }]),
      catalog_food_revisions: { data: null, error: { message: "db down" } },
    });

    const result = await warmEatsFacets(client as never, "user-1");

    expect(mocks.ensureCatalogRevisionFacets).not.toHaveBeenCalled();
    expect(result).toEqual({ foods: 1, warmed: 0, skipped: 0, errors: 1, stoppedEarly: false });
  });

  it("re-warms a food whose v2 warm stored only some occasion facets", async () => {
    mocks.activeRevisionsByFood.mockResolvedValue(new Map([[501, [9001]]]));
    const client = fakeClient({
      user_food_prefs: PREFS(["ref-catalog"]),
      food_refs: REFS([{ id: "ref-catalog", kind: "catalog", user_food_id: null, catalog_food_id: 501 }]),
      catalog_food_revisions: { data: [revision(9001)], error: null },
      food_facets: { data: [
        { food_key: "catalog_revision:9001", input_hash: hashOf(9001), facet: "human_food", rubric_version: 1 },
        { food_key: "catalog_revision:9001", input_hash: hashOf(9001), facet: "breakfast_fit", rubric_version: 2 },
      ], error: null },
    });

    const result = await warmEatsFacets(client as never, "user-1");

    expect(mocks.ensureCatalogRevisionFacets).toHaveBeenCalledWith([9001], expect.anything());
    expect(result).toMatchObject({ foods: 1, skipped: 0 });
  });

  it("caps the foods it sends to Jev at maxFoods, leaving the rest for next run", async () => {
    mocks.activeRevisionsByFood.mockResolvedValue(new Map([[1, [101]], [2, [102]], [3, [103]]]));
    const client = fakeClient({
      user_food_prefs: PREFS(["r1", "r2", "r3"]),
      food_refs: REFS([
        { id: "r1", kind: "catalog", user_food_id: null, catalog_food_id: 1 },
        { id: "r2", kind: "catalog", user_food_id: null, catalog_food_id: 2 },
        { id: "r3", kind: "catalog", user_food_id: null, catalog_food_id: 3 },
      ]),
      food_facets: { data: [], error: null },
    });

    const result = await warmEatsFacets(client as never, "user-1", { maxFoods: 2 });

    expect(mocks.ensureCatalogRevisionFacets).toHaveBeenCalledTimes(1);
    expect((mocks.ensureCatalogRevisionFacets.mock.calls[0][0] as number[])).toHaveLength(2);
    expect(result.foods).toBe(3);
    expect(result.skipped).toBe(1);
  });

  it("never sends a user-food ref the caller does not own", async () => {
    const client = fakeClient({
      user_food_prefs: PREFS(["ref-user"]),
      food_refs: REFS([
        { id: "ref-user", kind: "user", user_food_id: "not-mine", catalog_food_id: null },
      ]),
      // The user_foods read is scoped to this userId; a food owned by someone else never
      // comes back, so this fake simply returns nothing — exactly what that filter would do.
      user_foods: { data: [], error: null },
    });

    const result = await warmEatsFacets(client as never, "user-1");

    expect(mocks.ensureUserFoodFacets).not.toHaveBeenCalled();
    expect(result).toEqual({ foods: 0, warmed: 0, skipped: 0, errors: 0, stoppedEarly: false });
  });

  it("stops after a catalog batch reports provider trouble, and never starts the user-food batch",
    async () => {
      mocks.activeRevisionsByFood.mockResolvedValue(new Map([[1, [101]]]));
      mocks.ensureCatalogRevisionFacets.mockResolvedValue(errorResult());
      const client = fakeClient({
        user_food_prefs: PREFS(["ref-catalog", "ref-user"]),
        food_refs: REFS([
          { id: "ref-catalog", kind: "catalog", user_food_id: null, catalog_food_id: 1 },
          { id: "ref-user", kind: "user", user_food_id: "food-9", catalog_food_id: null },
        ]),
        user_foods: { data: [{ id: "food-9", rev: 1 }], error: null },
        food_facets: { data: [], error: null },
      });

      const result = await warmEatsFacets(client as never, "user-1");

      expect(mocks.ensureCatalogRevisionFacets).toHaveBeenCalledTimes(1);
      expect(mocks.ensureUserFoodFacets).not.toHaveBeenCalled();
      expect(result.stoppedEarly).toBe(true);
      expect(result.errors).toBe(1);
      expect(result.skipped).toBe(1);
    });

  it("reports one error and an empty result when a read fails, and never throws", async () => {
    const client = fakeClient({ user_food_prefs: { data: null, error: new Error("down") } });
    await expect(warmEatsFacets(client as never, "user-1")).resolves
      .toEqual({ foods: 0, warmed: 0, skipped: 0, errors: 1, stoppedEarly: false });
  });
});
