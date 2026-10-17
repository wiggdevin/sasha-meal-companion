// Audit finding S1: a shopping preview keeps a slot whose recipe the user already accepted. It is
// planned at its accepted recipe and serving (so the list still buys it), never re-chosen, and it
// carries the selection the SQL accept must still find unchanged.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingredient, recipe } from "../recipes/fixture";
import { HttpError } from "@/lib/server/auth";

const mocks = vi.hoisted(() => ({
  candidates: [] as unknown[],
  detail: vi.fn(),
  storePreview: vi.fn(async () => ({ data: "preview-1", error: null })),
}));

vi.mock("@/lib/server/targets", () => ({
  activeProfile: vi.fn(async () => ({ id: "target-1", rev: 3,
    training_macros: { kcal: 2000, protein: 120, carbs: 200, fat: 70 },
    rest_macros: { kcal: 2000, protein: 120, carbs: 200, fat: 70 } })),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ rpc: mocks.storePreview }) }));
vi.mock("@/lib/server/recipe-candidates", () => ({
  loadRecipeCandidates: vi.fn(async () => ({ candidates: mocks.candidates,
    noResultReasons: [], rulesFingerprint: "rules-1" })),
  loadRecipeDetail: mocks.detail,
}));
vi.mock("@/lib/shopping/repository", () => ({
  getPeriod: vi.fn(async () => null), listPantry: vi.fn(async () => []),
}));
vi.mock("@/lib/server/day-context", () => ({ loggedEntries: vi.fn(async () => []) }));
vi.mock("@/lib/recipes/slot-target", () => ({
  authoritativeSlotTarget: vi.fn(() => ({ kcal: 200, protein: 20, carbs: 20, fat: 5 })),
}));

const { previewShopping } = await import("@/lib/server/recipe-plan");

type Row = Record<string, unknown>;
/** A read-only PostgREST stand-in: equality and null filters only; range filters pass. */
function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  return { from(table: string) {
    const filters: [string, unknown][] = [];
    const rows = () => (tables[table] ?? []).filter((row) =>
      filters.every(([key, value]) => !(key in row) || row[key] === value));
    const builder: Record<string, unknown> = {
      select: () => builder, gte: () => builder, lte: () => builder, gt: () => builder,
      order: () => builder, limit: () => builder,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: rows(), error: null }),
    };
    return builder;
  } } as unknown as SupabaseClient;
}

const eligible = (partial: Parameters<typeof recipe>[0]) =>
  ({ ...recipe(partial), eligibility: { status: "eligible" as const, reasons: [] } });
const chosen = eligible({ recipeId: "chosen", revisionId: "chosen-v1", name: "Lentil soup",
  ingredients: [ingredient({ seq: 1, name: "lentils", foodRefId: "lentils" })] });
const better = eligible({ recipeId: "better", revisionId: "better-v1", name: "Bean stew",
  nutritionPerServing: { kcal: { value: 200, status: "known", sourceRevisionId: 1 },
    protein: { value: 20, status: "known", sourceRevisionId: 1 } } });

const draft = { startDate: "2026-10-01", endDate: "2026-10-02", timezone: "UTC", people: 1,
  mealCoverage: ["meal-3"], mode: "balanced" as const, effort: "standard" as const,
  maxActiveMinutes: null, variety: "high" as const, budgetAmount: null, currency: "USD",
  locale: "US-CO", lockMode: "none" as const };
const acceptedRow = { id: "11111111-1111-4111-8111-111111111111", user_id: "user-1",
  local_date: "2026-10-01", slot_id: "meal-3", recipe_id: "chosen", recipe_revision_id: "chosen-v1",
  recipe_name: "Lentil soup", serving_fraction: 1.5, plan_revision: 4, superseded_at: null };
const tables = (selections: Row[] = [acceptedRow]) => ({
  recipe_plan_state: [{ rev: 7 }], user_settings: [{ meals_per_day: 3, diet_prefs: null }],
  recipe_plan_selections: selections,
});
type StoredProof = { choices: Row[]; lines: { name: string; sources: Row[] }[];
  blockingIssues: string[] };
const storedProof = () => (mocks.storePreview.mock.calls.at(-1) as unknown as
  [string, { p_proof: StoredProof }])[1].p_proof;

describe("previewShopping with an accepted recipe selection", () => {
  beforeEach(() => {
    mocks.candidates = [chosen, better];
    mocks.detail.mockReset();
    mocks.storePreview.mockClear();
  });

  it("keeps the accepted slot at its recipe and serving, still buys it, and says so", async () => {
    const result = await previewShopping(fakeClient(tables()), "user-1", { draft, basket: [] });
    expect(result.blockingIssues).toEqual([]);
    expect(result.informationalIssues).toContain(
      "Keeps your chosen Lentil soup on 2026-10-01 Meal 3.");
    const day1 = result.choices.filter((row) => row.localDate === "2026-10-01");
    expect(day1).toHaveLength(1);
    expect(day1[0]).toMatchObject({ id: acceptedRow.id, keptSelectionId: acceptedRow.id,
      recipeRevisionId: "chosen-v1", servingFraction: 1.5, planRevision: 4 });
    // The open day is still planned fresh.
    expect(result.choices.find((row) => row.localDate === "2026-10-02"))
      .toMatchObject({ id: "", expectedSelectionId: null });
    const lentils = result.lines.find((line) => line.name === "lentils");
    expect(lentils?.sources.map((source) => source.localDate)).toEqual(["2026-10-01"]);
    expect(lentils?.needGrams).toBe(75);
    const proof = storedProof();
    expect(proof.choices.find((row) => row.localDate === "2026-10-01")).toMatchObject({
      keptSelectionId: acceptedRow.id, expectedSelectionId: acceptedRow.id,
      expectedPlanRevision: 4, servingsConsumed: 1.5, batchId: `kept:${acceptedRow.id}`,
      preparedOn: "2026-10-01" });
    expect(proof.choices.find((row) => row.localDate === "2026-10-02"))
      .toMatchObject({ expectedSelectionId: null });
    expect(proof.choices.find((row) => row.localDate === "2026-10-02"))
      .not.toHaveProperty("keptSelectionId");
  });

  it("re-plans a slot whose selection was superseded", async () => {
    const result = await previewShopping(fakeClient(tables([{ ...acceptedRow,
      superseded_at: "2026-09-30T12:00:00Z" }])), "user-1", { draft, basket: [] });
    expect(result.choices.every((row) => !row.keptSelectionId)).toBe(true);
    expect(result.choices.map((row) => row.localDate)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(result.choices[0]).toMatchObject({ id: "", expectedSelectionId: null });
    expect(result.informationalIssues.some((issue) => issue.startsWith("Keeps your chosen")))
      .toBe(false);
  });

  it("loads an accepted recipe outside the candidates at its accepted revision only", async () => {
    mocks.candidates = [better];
    mocks.detail.mockResolvedValueOnce({ recipe: chosen, rulesFingerprint: "rules-1" });
    const kept = await previewShopping(fakeClient(tables()), "user-1", { draft, basket: [] });
    expect(kept.choices.find((row) => row.localDate === "2026-10-01")?.keptSelectionId)
      .toBe(acceptedRow.id);

    mocks.detail.mockResolvedValueOnce({ recipe: { ...chosen, revisionId: "chosen-v2" },
      rulesFingerprint: "rules-1" });
    const changed = await previewShopping(fakeClient(tables()), "user-1", { draft, basket: [] });
    expect(changed.blockingIssues).toContain("Your chosen Lentil soup on 2026-10-01 Meal 3 "
      + "changed in the recipe catalog. Choose that meal again before planning this period.");
    expect(changed.choices.some((row) => row.localDate === "2026-10-01")).toBe(false);
  });

  it("blocks only the slot whose accepted recipe was withdrawn (W024, audit A047)", async () => {
    mocks.candidates = [better];
    mocks.detail.mockRejectedValueOnce(new HttpError(410, "recipe_withdrawn",
      "This recipe is no longer available for new plans."));
    const result = await previewShopping(fakeClient(tables()), "user-1", { draft, basket: [] });
    expect(result.blockingIssues).toEqual(["Your chosen Lentil soup on 2026-10-01 Meal 3 "
      + "is no longer in the recipe catalog. Choose that meal again before planning this period."]);
    expect(result.choices.some((row) => row.localDate === "2026-10-01")).toBe(false);
    expect(result.choices.find((row) => row.localDate === "2026-10-02")).toBeDefined();
  });

  it("still fails the preview for any other recipe read error", async () => {
    mocks.candidates = [better];
    mocks.detail.mockRejectedValueOnce(new HttpError(503, "recipe_catalog_unavailable"));
    await expect(previewShopping(fakeClient(tables()), "user-1", { draft, basket: [] }))
      .rejects.toMatchObject({ status: 503 });
  });

  it("blocks instead of re-choosing when the accepted recipe no longer fits the rules", async () => {
    mocks.candidates = [{ ...chosen, eligibility: { status: "blocked",
      reasons: [{ message: "Contains an avoided food." }] } }, better];
    const result = await previewShopping(fakeClient(tables()), "user-1", { draft, basket: [] });
    expect(result.blockingIssues).toContain("Your chosen Lentil soup on 2026-10-01 Meal 3 "
      + "no longer fits your food rules. Choose another recipe for that meal first.");
    expect(result.choices.some((row) => row.localDate === "2026-10-01")).toBe(false);
  });
});
