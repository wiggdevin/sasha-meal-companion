/**
 * Review round 3: the recipe rule read must not fail open. A failed food_facets read (readFacets
 * reports `errors`) or a failed user_allergen_checks query (readAllergenChecks reports `failed`)
 * is an unread rule set: the marked loaders answer unknown with no fingerprint, never a pass.
 * The real helpers run here against synthetic query errors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { recipe } from "./fixture";

const state = vi.hoisted(() => ({ fail: new Set<string>() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/recipe-catalog/repository", () => ({
  getPinnedRecipeRevisions: vi.fn(), searchCatalog: vi.fn(async () => [recipe()]),
  getCatalogRecipe: vi.fn(async () => recipe()),
}));
vi.mock("@/lib/server/constraints", () => ({ getRuleReviewStatus: vi.fn(async () => ({ required: false })) }));
vi.mock("@/lib/server/policy-profile", () => ({
  readPolicyProfile: vi.fn(async () => ({ profile: EMPTY_PROFILE, rev: 1, instances: [] })),
}));
vi.mock("@/lib/server/recipe-pilot-identity", () => ({ resolvePilotCatalogRevisions: vi.fn(async () => new Map()) }));

/** Every table answers empty, except the revision rows; a table in `state.fail` answers an error. */
function fake(): SupabaseClient {
  return { from: (table: string) => {
    const error = state.fail.has(table) ? { message: "synthetic outage" } : null;
    const data = error ? null : table === "catalog_food_revisions" ? [1, 2].map((id) => ({
      id, catalog_food_id: id, description: `Food ${id}`, brand: null, category: "legumes",
      prep_state: "cooked", policy_categories: [], catalog_ingredients: [], catalog_portions: [],
    })) : [];
    const query: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve),
      maybeSingle: async () => ({ data: null, error }),
    };
    for (const name of ["select", "eq", "is", "in", "or", "order", "limit", "range"]) query[name] = () => query;
    return query;
  } } as unknown as SupabaseClient;
}
vi.mock("@/lib/server/admin", () => ({ adminClient: () => fake() }));

const { loadMarkedRecipeCandidates, loadMarkedRecipeDetail, loadRecipeDetail } =
  await import("@/lib/server/recipe-candidates");
const { readAllergenChecks } = await import("@/lib/server/allergen-evidence");

beforeEach(() => { state.fail.clear(); });

describe("readAllergenChecks reports a failed query", () => {
  it("is failed (and empty) on a query error, not failed on success", async () => {
    state.fail.add("user_allergen_checks");
    const failed = await readAllergenChecks(fake(), "account", ["catalog_revision:1"]);
    expect(failed.failed).toBe(true);
    expect(failed.size).toBe(0);
    state.fail.clear();
    expect((await readAllergenChecks(fake(), "account", ["catalog_revision:1"])).failed).toBe(false);
    expect((await readAllergenChecks(fake(), "account", [])).failed).toBe(false);
  });
});

describe("recipe rule reads fail closed", () => {
  it("clears the recipe when every read succeeds", async () => {
    const detail = await loadMarkedRecipeDetail(fake(), "account", "stew");
    expect(detail?.rulesFingerprint).toEqual(expect.any(String));
    expect(detail?.recipe.ruleMark).toBeNull();
  });

  it.each(["food_facets", "user_allergen_checks", "food_allergen_evidence"])(
    "marks search and detail unknown with no fingerprint when %s fails", async (table) => {
      state.fail.add(table);
      const detail = await loadMarkedRecipeDetail(fake(), "account", "stew");
      expect(detail?.rulesFingerprint).toBeNull();
      expect(detail?.recipe.ruleMark).toMatchObject({ verdict: "unknown" });
      const found = await loadMarkedRecipeCandidates(fake(), "account", { query: "", limit: 3 });
      expect(found.rulesFingerprint).toBeNull();
      expect(found.candidates.map((row) => row.ruleMark?.verdict)).toEqual(["unknown"]);
      // The strict loader (shopping, coach) refuses rather than judging on a partial read.
      await expect(loadRecipeDetail(fake(), "account", "stew")).rejects.toBeTruthy();
    });
});
