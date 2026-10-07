/**
 * A recipe preview is a stored proof: when the account's rules cannot be read it stores nothing and
 * answers the explicit `recipe_rules_unchecked` exception carrying the unknown mark.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recipe } from "./fixture";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  storePreview: vi.fn(async () => ({ data: "preview-1", error: null })),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/targets", () => ({
  activeProfile: vi.fn(async () => ({ id: "target-1", rev: 3,
    training_macros: { kcal: 2000, protein: 120, carbs: 200, fat: 70 },
    rest_macros: { kcal: 2000, protein: 120, carbs: 200, fat: 70 } })),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ rpc: mocks.storePreview }) }));
vi.mock("@/lib/server/recipe-candidates", async (original) => ({
  ...(await original<typeof import("@/lib/server/recipe-candidates")>()),
  loadMarkedRecipeDetail: mocks.detail,
}));
vi.mock("@/lib/server/day-context", () => ({ loggedEntries: vi.fn(async () => []) }));
vi.mock("@/lib/recipes/slot-target", () => ({
  authoritativeSlotTarget: vi.fn(() => ({ kcal: 500, protein: 30, carbs: 50, fat: 15 })),
}));

const { previewRecipe } = await import("@/lib/server/recipe-plan");
const { RecipeRulesUnchecked } = await import("@/lib/server/recipe-candidates");

/** Fails the Nth read of a table (1-based); every other read is empty. */
let failing: { table: string; nth: number } | null = null;
const reads = new Map<string, number>();
const client = { from: (table: string) => {
  const n = (reads.get(table) ?? 0) + 1;
  reads.set(table, n);
  const error = failing?.table === table && failing.nth === n ? { message: "down" } : null;
  const builder: Record<string, unknown> = {
    maybeSingle: async () => ({ data: null, error }),
    then: (resolve: (value: unknown) => unknown) => resolve({ data: error ? null : [], error }),
  };
  for (const name of ["select", "eq", "is", "gte", "lte", "order", "limit"]) builder[name] = () => builder;
  return builder;
} } as unknown as SupabaseClient;

beforeEach(() => { failing = null; reads.clear(); mocks.storePreview.mockClear(); mocks.detail.mockReset(); });

const unknownMark = { verdict: "unknown" as const,
  reason: "This recipe could not be checked against your current food rules." };
const readable = () => mocks.detail.mockResolvedValue({ recipe: { ...recipe(), ruleMark: null,
  eligibility: { status: "eligible", reasons: [] } }, rulesFingerprint: "rules-1", preferenceFlags: [] });
const preview = () => previewRecipe(client, "user-1", "recipe-1",
  { date: "2026-10-06", slotId: "meal-2" }).catch((error: unknown) => error);

describe("previewRecipe rule reads after the detail (review round 2)", () => {
  it("stores a proof when every rule read succeeds", async () => {
    readable();
    expect(await preview()).toMatchObject({ previewId: "preview-1", ruleMark: null });
    expect(mocks.storePreview).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["constraint_profiles", 1],
    ["user_dietary_profiles", 1],
    // The second user_dietary_profiles read is the proof expiry's dated-rule edges.
    ["user_dietary_profiles", 2],
  ])("maps a failed %s read (#%i) to recipe_rules_unchecked and stores nothing", async (table, nth) => {
    readable();
    failing = { table, nth };
    const failure = await preview();
    expect(failure).toBeInstanceOf(RecipeRulesUnchecked);
    expect(failure).toMatchObject({ status: 422, code: "recipe_rules_unchecked", ruleMark: unknownMark });
    expect(mocks.storePreview).not.toHaveBeenCalled();
  });
});

describe("previewRecipe with unread rules", () => {
  it("throws recipe_rules_unchecked with the unknown mark and stores no proof", async () => {
    const mark = { verdict: "unknown" as const,
      reason: "This recipe could not be checked against your current food rules." };
    mocks.detail.mockResolvedValue({ recipe: { ...recipe(), ruleMark: mark,
      eligibility: { status: "unknown", reasons: [{ code: "rules_unavailable", message: mark.reason }] } },
    rulesFingerprint: null });
    const failure = await previewRecipe(client, "user-1", "recipe-1",
      { date: "2026-10-06", slotId: "meal-2" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RecipeRulesUnchecked);
    expect(failure).toMatchObject({ status: 422, code: "recipe_rules_unchecked", ruleMark: mark });
    expect(mocks.storePreview).not.toHaveBeenCalled();
  });
});
