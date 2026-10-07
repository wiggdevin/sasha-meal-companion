import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  adminClient: vi.fn(),
  eq: vi.fn(),
  from: vi.fn(),
  in: vi.fn(),
  or: vi.fn(),
  order: vi.fn(),
  range: vi.fn(),
  response: { data: [] as unknown[], error: null as null | { message: string } },
  select: vi.fn(),
}));

vi.mock("@/lib/server/admin", () => ({ adminClient: db.adminClient }));

const { chunkPairFilters, FACET_FILTER_MAX_CHARS, facetCacheKey, readFacets } =
  await import("@/lib/foods/facets");
const { OCCASION_RUBRIC_VERSION, RUBRIC_VERSION } = await import("@/lib/foods/facet-questions");
const HASH_A = `\\x${"a".repeat(64)}`;
const HASH_B = `\\x${"b".repeat(64)}`;

/** Lets a per-test `.or()` answer take the paged read's `.order()`/`.range()` tail. */
function paged<T extends object>(query: T): T {
  const chain: T = Object.assign(query, { order: () => chain, range: () => chain });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.response = { data: [], error: null };
  const query = {
    eq: db.eq,
    in: db.in,
    or: db.or,
    order: db.order,
    range: db.range,
    then: (resolve: (value: typeof db.response) => unknown) => Promise.resolve(db.response).then(resolve),
  };
  db.eq.mockReturnValue(query);
  db.in.mockReturnValue(query);
  db.or.mockReturnValue(query);
  db.order.mockReturnValue(query);
  db.range.mockReturnValue(query);
  db.select.mockReturnValue(query);
  db.from.mockReturnValue({ select: db.select });
  db.adminClient.mockReturnValue({ from: db.from });
});

describe("readFacets", () => {
  it("uses a supplied target client instead of the process-global admin", async () => {
    const target = { from: db.from } as unknown as Parameters<typeof readFacets>[2];
    const result = await readFacets([{ foodKey: "catalog_revision:1", inputHash: HASH_A }],
      ["human_food"], target);
    expect(result.errors).toBe(0);
    expect(db.from).toHaveBeenCalledWith("food_facets");
    expect(db.adminClient).not.toHaveBeenCalled();
  });

  it("returns matching cached rows in a Map without making a provider call", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    db.response.data = [
      { food_key: "catalog_revision:1", input_hash: HASH_A, facet: "human_food",
        rubric_version: 1, p: "0.998", judged_at: "2026-09-19T12:00:00.000Z" },
      { food_key: "catalog_revision:1", input_hash: HASH_A, facet: "breakfast_fit",
        rubric_version: 2, p: 0.75, judged_at: "2026-09-19T12:01:00.000Z" },
    ];

    const result = await readFacets([{ foodKey: "catalog_revision:1", inputHash: HASH_A }]);

    expect(result).toBeInstanceOf(Map);
    expect(result.errors).toBe(0);
    expect(result.get(facetCacheKey({ foodKey: "catalog_revision:1", inputHash: HASH_A }))).toEqual({
      human_food: { p: 0.998, rubricVersion: 1, judgedAt: "2026-09-19T12:00:00.000Z" },
      breakfast_fit: { p: 0.75, rubricVersion: 2, judgedAt: "2026-09-19T12:01:00.000Z" },
    });
    expect(db.in).toHaveBeenCalledWith("rubric_version", [RUBRIC_VERSION, OCCASION_RUBRIC_VERSION]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never returns a rubric-v1 occasion row as a current (v2) judgment", async () => {
    db.response.data = [
      { food_key: "catalog_revision:1", input_hash: HASH_A, facet: "breakfast_fit",
        rubric_version: 1, p: 0.99, judged_at: "2026-09-19T12:00:00.000Z" },
      { food_key: "catalog_revision:1", input_hash: HASH_A, facet: "contains_gluten",
        rubric_version: 2, p: 0.99, judged_at: "2026-09-19T12:00:00.000Z" },
    ];
    const result = await readFacets([{ foodKey: "catalog_revision:1", inputHash: HASH_A }],
      ["breakfast_fit", "contains_gluten"]);
    expect([...result]).toEqual([]);
    expect(result.errors).toBe(0);
  });

  it("treats stale rubric versions and input hashes as clean misses", async () => {
    db.response.data = [
      { food_key: "catalog_revision:1", input_hash: HASH_B, facet: "human_food",
        rubric_version: 1, p: 0.99, judged_at: "2026-09-19T12:00:00.000Z" },
      { food_key: "catalog_revision:1", input_hash: HASH_A, facet: "human_food",
        rubric_version: 2, p: 0.98, judged_at: "2026-09-19T12:00:00.000Z" },
    ];
    const result = await readFacets(
      [{ foodKey: "catalog_revision:1", inputHash: HASH_A }], ["human_food"],
    );
    expect([...result.entries()]).toEqual([]);
    expect(result.errors).toBe(0);
  });

  it("keeps judgments for two hashes of the same food under distinct cache keys", async () => {
    db.response.data = [
      { food_key: "catalog_revision:1", input_hash: HASH_A, facet: "human_food",
        rubric_version: 1, p: 0.9, judged_at: "2026-09-19T12:00:00.000Z" },
      { food_key: "catalog_revision:1", input_hash: HASH_B, facet: "human_food",
        rubric_version: 1, p: 0.7, judged_at: "2026-09-19T12:01:00.000Z" },
    ];

    const result = await readFacets([
      { foodKey: "catalog_revision:1", inputHash: HASH_A },
      { foodKey: "catalog_revision:1", inputHash: HASH_B },
    ], ["human_food"]);

    expect(result.get(facetCacheKey({ foodKey: "catalog_revision:1", inputHash: HASH_A }))
      ?.human_food?.p).toBe(0.9);
    expect(result.get(facetCacheKey({ foodKey: "catalog_revision:1", inputHash: HASH_B }))
      ?.human_food?.p).toBe(0.7);
    expect(result.size).toBe(2);
  });

  it("queries and returns only the two requested food and hash pairs", async () => {
    db.response.data = [
      { food_key: "catalog_revision:1", input_hash: HASH_A, facet: "human_food",
        rubric_version: 1, p: 0.9, judged_at: "2026-09-19T12:00:00.000Z" },
      { food_key: "catalog_revision:2", input_hash: HASH_B, facet: "human_food",
        rubric_version: 1, p: 0.8, judged_at: "2026-09-19T12:00:00.000Z" },
      { food_key: "catalog_revision:1", input_hash: HASH_B, facet: "human_food",
        rubric_version: 1, p: 0.2, judged_at: "2026-09-19T12:00:00.000Z" },
      { food_key: "catalog_revision:2", input_hash: HASH_A, facet: "human_food",
        rubric_version: 1, p: 0.1, judged_at: "2026-09-19T12:00:00.000Z" },
    ];

    const result = await readFacets([
      { foodKey: "catalog_revision:1", inputHash: HASH_A },
      { foodKey: "catalog_revision:2", inputHash: HASH_B },
    ], ["human_food"]);

    expect([...result.keys()]).toEqual([
      facetCacheKey({ foodKey: "catalog_revision:1", inputHash: HASH_A }),
      facetCacheKey({ foodKey: "catalog_revision:2", inputHash: HASH_B }),
    ]);
    expect(db.or).toHaveBeenCalledOnce();
    const pairFilter = String(db.or.mock.calls[0][0]);
    expect(pairFilter).toContain(
      `and(food_key.eq."catalog_revision:1",input_hash.eq."\\\\x${"a".repeat(64)}")`,
    );
    expect(pairFilter).toContain(
      `and(food_key.eq."catalog_revision:2",input_hash.eq."\\\\x${"b".repeat(64)}")`,
    );
    expect(pairFilter).not.toContain(
      `and(food_key.eq."catalog_revision:1",input_hash.eq."\\\\x${"b".repeat(64)}")`,
    );
    expect(pairFilter).not.toContain(
      `and(food_key.eq."catalog_revision:2",input_hash.eq."\\\\x${"a".repeat(64)}")`,
    );
  });

  it("drops a key with any malformed row and counts the error (t18 r2)", async () => {
    db.response.data = [
      { food_key: "user_food:u1:2", input_hash: HASH_A, facet: "contains_gluten",
        rubric_version: 1, p: 0.91, judged_at: "2026-09-19T12:00:00.000Z" },
      { food_key: "user_food:u1:2", input_hash: HASH_A, facet: "contains_dairy",
        rubric_version: 1, p: "wrong", judged_at: "2026-09-19T12:00:00.000Z" },
    ];
    const result = await readFacets(
      [{ foodKey: "user_food:u1:2", inputHash: HASH_A }],
      ["contains_gluten", "contains_dairy"],
    );
    // A malformed contains_dairy beside a good contains_gluten must not read as "no dairy".
    const key = { foodKey: "user_food:u1:2", inputHash: HASH_A };
    expect(result.get(facetCacheKey(key))).toBeUndefined();
    expect(result.failed(key)).toBe(true);
    expect(result.errors).toBe(1);
  });

  it("leaves every malformed probability unknown and counts each error", async () => {
    db.response.data = [null, "x", 1.5, -0.1].map((p, index) => ({
      food_key: "catalog_revision:1",
      input_hash: HASH_A,
      facet: ["human_food", "breakfast_fit", "lunch_fit", "dinner_fit"][index],
      rubric_version: index === 0 ? 1 : 2,
      p,
      judged_at: "2026-09-19T12:00:00.000Z",
    }));

    const result = await readFacets(
      [{ foodKey: "catalog_revision:1", inputHash: HASH_A }],
      ["human_food", "breakfast_fit", "lunch_fit", "dinner_fit"],
    );

    expect([...result]).toEqual([]);
    expect(result.errors).toBe(4);
  });

  it("normalises bytea hex and base64 hashes plus string and Date timestamps", async () => {
    const base64Hash = Buffer.from("a".repeat(64), "hex").toString("base64");
    db.response.data = [
      { food_key: "catalog_revision:1", input_hash: HASH_A.toUpperCase(), facet: "human_food",
        rubric_version: 1, p: 0.9, judged_at: "2026-09-19T06:00:00-06:00" },
      { food_key: "catalog_revision:1", input_hash: base64Hash, facet: "breakfast_fit",
        rubric_version: 2, p: 0.8, judged_at: new Date("2026-09-19T12:01:00.000Z") },
    ];

    const result = await readFacets(
      [{ foodKey: "catalog_revision:1", inputHash: HASH_A }],
      ["human_food", "breakfast_fit"],
    );

    expect(result.errors).toBe(0);
    expect(result.get(facetCacheKey({ foodKey: "catalog_revision:1", inputHash: HASH_A })))
      .toEqual({
        human_food: { p: 0.9, rubricVersion: 1, judgedAt: "2026-09-19T12:00:00.000Z" },
        breakfast_fit: { p: 0.8, rubricVersion: 2, judgedAt: "2026-09-19T12:01:00.000Z" },
      });
  });

  it("never throws when the cache read fails", async () => {
    db.response.error = { message: "database unavailable" };
    const failed = await readFacets([{ foodKey: "catalog_revision:1", inputHash: HASH_A }]);
    expect([...failed]).toEqual([]);
    expect(failed.errors).toBe(1);

    db.adminClient.mockImplementation(() => { throw new Error("missing environment"); });
    const threw = await readFacets([{ foodKey: "catalog_revision:1", inputHash: HASH_A }]);
    expect([...threw]).toEqual([]);
    expect(threw.errors).toBe(1);
  });

  it("drops rows returned alongside a cache error and reports the key failed (t18 r2)", async () => {
    db.response = {
      data: [{ food_key: "catalog_revision:1", input_hash: HASH_A, facet: "human_food",
        rubric_version: 1, p: 0.8, judged_at: "2026-09-19T12:00:00.000Z" }],
      error: { message: "partial response" },
    };
    const key = { foodKey: "catalog_revision:1", inputHash: HASH_A };
    const result = await readFacets([key]);
    expect(result.get(facetCacheKey(key))).toBeUndefined();
    expect(result.failed(key)).toBe(true);
    expect(result.errors).toBe(1);
  });

  it("splits a large Eats list (>150 keys) into bounded requests and keeps every answer", async () => {
    const keys = Array.from({ length: 160 }, (_, index) => ({
      foodKey: `user_food:00000000-0000-4000-8000-${String(index).padStart(12, "0")}:3`,
      inputHash: `\\x${index.toString(16).padStart(64, "0")}`,
    }));
    const rowsFor = (filter: string) => keys
      .filter((key) => filter.includes(`"${key.foodKey}"`))
      .map((key) => ({ food_key: key.foodKey, input_hash: key.inputHash, facet: "human_food",
        rubric_version: 1, p: 0.9, judged_at: "2026-09-19T12:00:00.000Z" }));
    db.or.mockImplementation((filter: string) => paged({
      then: (resolve: (value: typeof db.response) => unknown) =>
        Promise.resolve({ data: rowsFor(filter), error: null }).then(resolve),
    }));

    const result = await readFacets(keys, ["human_food"]);

    expect(result.errors).toBe(0);
    expect(result.size).toBe(160);
    expect(db.or.mock.calls.length).toBeGreaterThan(1);
    const sent = db.or.mock.calls.map(([filter]) => String(filter));
    for (const filter of sent) {
      expect(encodeURIComponent(filter).length).toBeLessThanOrEqual(FACET_FILTER_MAX_CHARS);
    }
    // Every key is asked for exactly once across the chunks.
    expect(sent.join(",").match(/and\(food_key/g)).toHaveLength(160);
  });

  it("counts and logs a failed chunk without dropping answers from the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const keys = Array.from({ length: 160 }, (_, index) => ({
      foodKey: `catalog_revision:${100_000 + index}`,
      inputHash: `\\x${index.toString(16).padStart(64, "0")}`,
    }));
    let call = 0;
    db.or.mockImplementation((filter: string) => {
      call += 1;
      const first = call === 1;
      const rows = keys.filter((key) => filter.includes(`"${key.foodKey}"`))
        .map((key) => ({ food_key: key.foodKey, input_hash: key.inputHash, facet: "human_food",
          rubric_version: 1, p: 0.9, judged_at: "2026-09-19T12:00:00.000Z" }));
      return paged({
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          (first ? Promise.reject(new TypeError("fetch failed")) : Promise.resolve({ data: rows, error: null }))
            .then(resolve, reject),
      });
    });

    const result = await readFacets(keys, ["human_food"]);

    expect(call).toBeGreaterThan(1);
    expect(result.errors).toBe(1);
    expect(result.size).toBeGreaterThan(0);
    expect(result.size).toBeLessThan(160);
    // Every key is either answered or reported failed with no judgments, never both.
    for (const key of keys) {
      const failed = result.failed(key);
      expect(failed ? result.get(facetCacheKey(key)) : "ok").toBe(failed ? undefined : "ok");
    }
    expect(keys.filter((key) => result.failed(key)).length).toBe(160 - result.size);
    expect(warn).toHaveBeenCalledWith("[facets] cache read failed",
      expect.objectContaining({ message: "fetch failed" }));
    warn.mockRestore();
  });

  it("chunks pair filters by encoded size, never splitting a single clause", () => {
    expect(chunkPairFilters([])).toEqual([]);
    const big = "x".repeat(50);
    expect(chunkPairFilters([big, big, big], 60)).toEqual([[big], [big], [big]]);
    expect(chunkPairFilters(["a", "b", "c"], 100)).toEqual([["a", "b", "c"]]);
  });

  it("does not touch the database for an empty request", async () => {
    const result = await readFacets([]);
    expect(result.errors).toBe(0);
    expect(db.adminClient).not.toHaveBeenCalled();
  });
});
