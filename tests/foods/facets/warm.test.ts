import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const systemOneMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/typesafe", async (original) => ({
  ...(await original<typeof import("@/lib/ai/typesafe")>()),
  systemOne: (p: { state: unknown; questions: unknown; purpose: string }, o?: object) =>
    systemOneMock(p.state, p.questions, { ...o, purpose: p.purpose }),
}));

const { FACET_BATCH_TOKEN_LIMIT, ensureFacets } = await import("@/lib/foods/facet-warm");
const { FACETS, facetRubricVersion } = await import("@/lib/foods/facets");
const { inputHash } = await import("@/lib/foods/facet-keys");
const { facetState } = await import("@/lib/foods/facet-questions");
const { claimJevCall, withJevBudget } = await import("@/lib/ai/request-budget");

type CacheRow = { food_key: string; input_hash: string; facet: string; rubric_version: number };

function adminWith(existing: CacheRow[] = [], writeError: { message: string } | null = null,
  facetReadError: { message: string } | null = null) {
  const upsert = vi.fn(async (_rows: unknown, _options?: unknown) =>
    ({ data: null, error: writeError }));
  const response = { data: existing, error: null };
  const query = {
    eq: vi.fn(),
    in: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    then: (resolve: (value: typeof response) => unknown) => Promise.resolve(response).then(resolve),
  };
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  // Only the facet cache read (readFacets) chains `.or()`; it can be made to fail on its own.
  const failing = { ...query, then: (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: null, error: facetReadError }).then(resolve) };
  failing.order = vi.fn(() => failing);
  failing.range = vi.fn(() => failing);
  query.or.mockReturnValue(facetReadError ? failing : query);
  query.order.mockReturnValue(query);
  query.range.mockReturnValue(query);
  const select = vi.fn(() => query);
  const writes: { table: string; rows: unknown }[] = [];
  const from = vi.fn((table: string) => ({ select, upsert: (rows: unknown, options?: unknown) => {
    writes.push({ table, rows });
    return upsert(rows, options);
  } }));
  const facetWrites = () => writes.filter((write) => write.table === "food_facets");
  return { client: { from } as unknown as SupabaseClient, from, upsert, writes, facetWrites };
}

function catalogFood(id: number, overrides: Record<string, unknown> = {}) {
  return {
    identity: { kind: "catalog_revision" as const, id },
    name: `Food ${id}`,
    brand: "Plain brand",
    category: "prepared food",
    serving: "ready to eat",
    ingredientsText: "rice, water",
    ...overrides,
  };
}

function allYes(questions: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(questions).map((key) =>
    [key, { type: "noul", noul: 0.8764 }]));
}

beforeEach(() => {
  vi.clearAllMocks();
  systemOneMock.mockImplementation(async (_state, questions) => allYes(questions));
});

describe("ensureFacets", () => {
  it("judges every v1 facet using food-only state and persists exact cache identities", async () => {
    const admin = adminWith();
    const result = await ensureFacets([catalogFood(41, {
      userId: "private-user-canary",
      weight: "private-weight-canary",
      notes: "private-gut-note-canary",
    })], { admin: admin.client, userId: "accounting-user" });

    expect(result).toMatchObject({ judged: FACETS.length, skipped: 0, unknown: 0,
      writes: FACETS.length, errors: 0 });
    expect(systemOneMock).toHaveBeenCalledOnce();
    const [state, questions, options] = systemOneMock.mock.calls[0];
    expect(state).toEqual({ foods: [{
      name: "Food 41", brand: "Plain brand", ingredientsText: "rice, water",
      description: "prepared food", preparation: "ready to eat",
    }] });
    expect(Object.keys(questions)).toHaveLength(FACETS.length);
    expect(Object.values(questions as Record<string, { type: string }>)
      .every((question) => question.type === "noul")).toBe(true);
    expect(options).toMatchObject({ purpose: "food_facets", userId: "accounting-user" });
    const serialised = JSON.stringify(state);
    for (const canary of ["private-user-canary", "private-weight-canary",
      "private-gut-note-canary", "accounting-user"]) expect(serialised).not.toContain(canary);

    const rows = admin.upsert.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows).toHaveLength(FACETS.length);
    expect(rows[0]).toMatchObject({
      food_key: "catalog_revision:41", facet: FACETS[0], rubric_version: 1,
      p: 0.876, model: "jev-latest", user_id: null,
    });
    expect(rows[0].input_hash).toBe(inputHash({ name: "Food 41", brand: "Plain brand",
      description: "prepared food", preparation: "ready to eat",
      ingredientsText: "rice, water" }));
  });

  it("asks Jev the same full question set for every food, and stores only the missing facets (§9 R4)", async () => {
    const food = catalogFood(7);
    const hash = inputHash({ name: food.name, brand: food.brand, description: food.category,
      preparation: food.serving, ingredientsText: food.ingredientsText });
    const existing = FACETS.slice(0, 2).map((facet) => ({
      food_key: "catalog_revision:7", input_hash: hash, facet, rubric_version: 1,
    }));
    const admin = adminWith(existing);

    const result = await ensureFacets([food], { admin: admin.client, userId: "accounting-user" });

    expect(result).toMatchObject({ judged: FACETS.length - 2, skipped: 2, unknown: 0 });
    expect(Object.keys(systemOneMock.mock.calls[0][1])).toHaveLength(FACETS.length);
    const rows = admin.upsert.mock.calls[0][0] as { facet: string }[];
    expect(rows.map((row) => row.facet)).toEqual(FACETS.slice(2));
  });

  it("makes no provider call when every facet is already cached", async () => {
    const food = catalogFood(8);
    const hash = inputHash({ name: food.name, brand: food.brand, description: food.category,
      preparation: food.serving, ingredientsText: food.ingredientsText });
    const existing = FACETS.map((facet) => ({
      food_key: "catalog_revision:8", input_hash: hash, facet, rubric_version: facetRubricVersion(facet),
    }));

    const result = await ensureFacets([food], {
      admin: adminWith(existing).client, userId: "accounting-user",
    });

    expect(result).toMatchObject({ judged: 0, skipped: FACETS.length, unknown: 0, errors: 0 });
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("re-warms occasion facets judged under rubric v1 at v2, without reinterpreting the v1 rows", async () => {
    const food = catalogFood(81);
    const hash = inputHash({ name: food.name, brand: food.brand, description: food.category,
      preparation: food.serving, ingredientsText: food.ingredientsText });
    const occasion = ["breakfast_fit", "lunch_fit", "dinner_fit", "snack_fit"];
    // Everything judged before O3: every facet at v1, occasion facets included.
    const existing = FACETS.map((facet) => ({
      food_key: "catalog_revision:81", input_hash: hash, facet, rubric_version: 1,
    }));
    const admin = adminWith(existing);

    const result = await ensureFacets([food], { admin: admin.client, userId: "accounting-user" });

    expect(result).toMatchObject({ judged: 4, skipped: FACETS.length - 4, unknown: 0, errors: 0 });
    const questions = systemOneMock.mock.calls[0][1] as Record<string, { instructions: string }>;
    expect(questions.food_0__breakfast_fit.instructions)
      .toMatch(/typical choice at breakfast for most people who eat this food/);
    const rows = admin.upsert.mock.calls[0][0] as { facet: string; rubric_version: number }[];
    expect(rows.map((row) => row.facet)).toEqual(occasion);
    expect(rows.every((row) => row.rubric_version === 2)).toBe(true);
    // Upserts add v2 rows beside the v1 ones (rubric_version is in the key); nothing is updated.
    expect(admin.upsert.mock.calls[0][1]).toMatchObject({ ignoreDuplicates: true });
  });

  it("uses measured serialized request bytes to split batches below the 50-percent limit", async () => {
    const admin = adminWith();
    const ingredientBlock = "ingredient ".repeat(3_000);
    const result = await ensureFacets([
      catalogFood(1, { ingredientsText: `${ingredientBlock}one` }),
      catalogFood(2, { ingredientsText: `${ingredientBlock}two` }),
    ], { admin: admin.client, userId: "accounting-user" });

    expect(result.batches).toHaveLength(2);
    expect(result.batches.every((batch) => batch.estimatedTokens <= FACET_BATCH_TOKEN_LIMIT))
      .toBe(true);
    expect(result.batches.every((batch) => batch.foods === 1)).toBe(true);
    expect(systemOneMock).toHaveBeenCalledTimes(2);
  });

  it("leaves misses unknown when the provider returns null", async () => {
    systemOneMock.mockResolvedValue(null);
    const admin = adminWith();

    const result = await ensureFacets([catalogFood(9)],
      { admin: admin.client, userId: "accounting-user" });

    expect(result).toMatchObject({ judged: 0, skipped: 0, unknown: FACETS.length,
      writes: 0, errors: 1 });
    expect(admin.facetWrites()).toEqual([]);
  });

  it("turns a thrown provider failure into retryable unknowns", async () => {
    systemOneMock.mockRejectedValue(new Error("provider unavailable"));

    await expect(ensureFacets([catalogFood(91)], {
      admin: adminWith().client, userId: "accounting-user",
    })).resolves.toMatchObject({
      judged: 0, unknown: FACETS.length, retryableUnknown: FACETS.length,
      nonRetryable: [], writes: 0, errors: 1,
    });
  });

  it("fails open without an accounting user and never calls the provider", async () => {
    const result = await ensureFacets([catalogFood(92)], { admin: adminWith().client });

    expect(result).toMatchObject({ judged: 0, unknown: FACETS.length,
      retryableUnknown: FACETS.length, writes: 0, errors: 1 });
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("classifies a food over the batch ceiling as non-retryable", async () => {
    const result = await ensureFacets([
      catalogFood(93, { ingredientsText: "oversized ".repeat(FACET_BATCH_TOKEN_LIMIT) }),
    ], { admin: adminWith().client, userId: "accounting-user" });

    expect(result).toMatchObject({ judged: 0, unknown: FACETS.length,
      retryableUnknown: 0, writes: 0, errors: 1 });
    expect(result.nonRetryable).toEqual([{
      foodKey: "catalog_revision:93", unknown: FACETS.length, reason: "oversized",
    }]);
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("sends a user food's name, brand and ingredients only, trimmed to schema lengths (§9 R4)", async () => {
    const admin = adminWith();
    await ensureFacets([{ identity: { kind: "user_food", id: "11111111-1111-4111-8111-111111111111",
      rev: 1 }, name: "N".repeat(300), brand: "B".repeat(300), ingredientsText: "oats, salt",
      category: "private note: my colitis food", serving: "after my flare",
      ownerUserId: "owner" }], { admin: admin.client, userId: "accounting-user" });
    expect(systemOneMock.mock.calls[0][0]).toEqual({ foods: [{ name: "N".repeat(160),
      brand: "B".repeat(120), ingredientsText: "oats, salt" }] });
  });

  it("never sends a user food whose ingredient list is longer than its schema (no cut lists)", async () => {
    const result = await ensureFacets([{ identity: { kind: "user_food",
      id: "22222222-2222-4222-8222-222222222222", rev: 1 }, name: "Long", ingredientsText:
      "rice, ".repeat(1_000), ownerUserId: "owner" }],
    { admin: adminWith().client, userId: "accounting-user" });
    expect(systemOneMock).not.toHaveBeenCalled();
    expect(result.nonRetryable).toHaveLength(1);
  });

  it("records allergen evidence for every warmed food and reports coverage (§5)", async () => {
    const admin = adminWith();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await ensureFacets([catalogFood(95, { labelComplete: true,
      ingredientsText: "Water, rice flour, salt, milk powder" })],
    { admin: admin.client, userId: "accounting-user" });
    const evidence = admin.writes.find((write) => write.table === "food_allergen_evidence")
      ?.rows as { allergen: string; level: string; label_complete: boolean }[];
    expect(evidence.find((row) => row.allergen === "dairy")).toMatchObject({ level: "listed" });
    expect(evidence.find((row) => row.allergen === "egg"))
      .toMatchObject({ level: "not_listed", label_complete: true });
    expect(result.allergenEvidence).toMatchObject({ coverage: 1, errors: 0 });
    expect(info).toHaveBeenCalledWith("[allergen-coverage]", expect.stringContaining('"coverage":1'));
    // sol BLOCK (review round 2): the batch this call warms is one account's own recently-touched
    // food(s), not a catalog-wide sample — but the logged line carried no account key at all, so
    // nothing could roll per-call batches up into the account's real coverage over time (the
    // "share of the user's recent foods" §5 promises). Without a userId, one call's 0% or 100% is
    // indistinguishable from any other account's, or from a catalog-wide warm's.
    expect(info).toHaveBeenCalledWith("[allergen-coverage]",
      expect.stringContaining('"userId":"accounting-user"'));
    info.mockRestore();
  });

  it("writes deterministic allergen evidence even when the facet read failed (Phase 18 W2a)", async () => {
    // Evidence no longer reads any Jev facet, so a facet outage cannot change it: a complete label
    // that names no egg is deterministic `not_listed`, written with a non-Jev source.
    const admin = adminWith([], null, { message: "synthetic outage" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await ensureFacets([catalogFood(97, { labelComplete: true,
      ingredientsText: "Water, rice flour, salt" })], { admin: admin.client, userId: "accounting-user" });
    const rows = admin.writes.filter((write) => write.table === "food_allergen_evidence")
      .flatMap((write) => write.rows as { allergen: string; level: string; source: string }[]);
    expect(rows.find((row) => row.allergen === "egg")).toMatchObject({ level: "not_listed", source: "label" });
    expect(rows.some((row) => row.source === "jev")).toBe(false);
    warn.mockRestore();
    info.mockRestore();
  });

  it("logs userId: null for a catalog-wide warm with no single account in view (sol BLOCK, " +
    "review round 2)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await ensureFacets([catalogFood(96, { labelComplete: true,
      ingredientsText: "Water, rice flour, salt, milk powder" })], { admin: adminWith().client });
    expect(info).toHaveBeenCalledWith("[allergen-coverage]", expect.stringContaining('"userId":null'));
    info.mockRestore();
  });

  it("uses the same canonical provider state as the facet evaluator", async () => {
    const food = catalogFood(94);
    await ensureFacets([food], { admin: adminWith().client, userId: "accounting-user" });

    expect(systemOneMock.mock.calls[0][0]).toEqual({ foods: [facetState({
      name: food.name, brand: food.brand, description: food.category,
      preparation: food.serving, ingredientsText: food.ingredientsText,
    })] });
  });

  it("warms outside a request scope whose three logical calls are already spent", async () => {
    systemOneMock.mockImplementation(async (_state, questions, options) =>
      claimJevCall(options.purpose, "facet-warm-test") ? allYes(questions) : null);

    const result = await withJevBudget(async () => {
      expect(claimJevCall("intent", "1")).toBe(true);
      expect(claimJevCall("ranking", "2")).toBe(true);
      expect(claimJevCall("sanity", "3")).toBe(true);
      return ensureFacets([catalogFood(95)], {
        admin: adminWith().client, userId: "accounting-user",
      });
    });

    expect(result.judged).toBe(FACETS.length);
    expect(systemOneMock).toHaveBeenCalledOnce();
  });

  it("never throws and leaves judgments unknown when the cache write fails", async () => {
    const admin = adminWith([], { message: "write unavailable" });

    await expect(ensureFacets([catalogFood(10)],
      { admin: admin.client, userId: "accounting-user" })).resolves.toMatchObject({
        judged: 0, skipped: 0, unknown: FACETS.length, writes: 0, errors: 1,
      });
  });

  it("plans a dry run without provider calls or writes", async () => {
    const admin = adminWith();
    const result = await ensureFacets([catalogFood(11)], { admin: admin.client, dryRun: true });

    expect(result).toMatchObject({ judged: 0, skipped: 0, unknown: FACETS.length, writes: 0 });
    expect(result.batches).toHaveLength(1);
    expect(systemOneMock).not.toHaveBeenCalled();
    expect(admin.upsert).not.toHaveBeenCalled();
  });
});
