/**
 * Recipe planning surfaces carry the same `ruleMark` the selection GET gives an accepted row:
 * search results, detail, the preview and the accept response. Unreadable is unknown, never a pass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import type { CatalogRecipe, RecipeCandidate } from "@/lib/recipe-catalog/types";
import { recipe } from "./fixture";

const mocks = vi.hoisted(() => ({ recipes: [] as unknown[], pinnedError: null as Error | null,
  searchError: null as Error | null, policyError: null as Error | null, review: false }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/recipe-catalog/repository", () => ({
  getPinnedRecipeRevisions: vi.fn(async () => {
    if (mocks.pinnedError) throw mocks.pinnedError;
    return mocks.recipes;
  }),
  getCatalogRecipe: vi.fn(async (_client: unknown, id: string) => {
    if (mocks.searchError) throw mocks.searchError;
    return (mocks.recipes as CatalogRecipe[]).find((row) => row.recipeId === id) ?? null;
  }),
  searchCatalog: vi.fn(async () => {
    if (mocks.searchError) throw mocks.searchError;
    return mocks.recipes;
  }),
}));
vi.mock("@/lib/server/constraints", () => ({
  getRuleReviewStatus: vi.fn(async () => ({ required: mocks.review })),
}));
vi.mock("@/lib/server/policy-profile", () => ({
  readPolicyProfile: vi.fn(async () => {
    if (mocks.policyError) throw mocks.policyError;
    return { profile: EMPTY_PROFILE, rev: 1, instances: [] };
  }),
}));
vi.mock("@/lib/server/recipe-pilot-identity", () => ({ resolvePilotCatalogRevisions: vi.fn(async () => new Map()) }));
vi.mock("@/lib/server/allergen-evidence", () => ({
  readAllergenEvidence: vi.fn(async () => new Map()), readAllergenChecks: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/foods/facets", () => ({ readFacets: vi.fn(async () => new Map()), facetCacheKey: () => "none" }));

const {
  acceptedSelectionRuleMark, candidateRuleMark, loadMarkedRecipeCandidates, loadMarkedRecipeDetail,
  withRuleMark,
} = await import("@/lib/server/recipe-candidates");
const { HttpError } = await import("@/lib/server/auth");

const client = { from: () => {
  const result = { data: [], error: null };
  const query: Record<string, unknown> = {
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    maybeSingle: async () => ({ data: null, error: null }),
  };
  for (const name of ["select", "eq", "is", "in", "order", "range"]) query[name] = () => query;
  return query;
} } as unknown as SupabaseClient;

const pinned: CatalogRecipe = recipe({ revisionId: "rev" });
const eligible: RecipeCandidate = { ...pinned, eligibility: { status: "eligible", reasons: [] } };
const lineFor = (item: CatalogRecipe["ingredients"][number]) => ({ seq: item.seq, name: item.name,
  foodRefId: item.foodRefId, foodDbId: item.foodDbId ?? null, foodRevisionId: item.catalogFoodRevisionId });

beforeEach(() => {
  mocks.recipes = [pinned]; mocks.pinnedError = null; mocks.searchError = null;
  mocks.policyError = null; mocks.review = false;
});

describe("candidateRuleMark (search, detail, preview)", () => {
  it("clears an eligible recipe and attaches the mark without changing the recipe", () => {
    expect(candidateRuleMark(eligible)).toBeNull();
    const marked = withRuleMark(eligible);
    expect(marked.ruleMark).toBeNull();
    expect(marked.eligibility).toEqual(eligible.eligibility);
  });

  it("marks a rule block blocked and an unchecked rule unknown, with the eligibility message", () => {
    expect(candidateRuleMark({ ...pinned, eligibility: { status: "blocked",
      reasons: [{ code: "avoid_list", message: "Peanuts are on your Avoid list." }] } }))
      .toEqual({ verdict: "blocked", reason: "Peanuts are on your Avoid list." });
    expect(candidateRuleMark({ ...pinned, eligibility: { status: "unknown",
      reasons: [{ code: "allergen_unknown", message: "Peanut could not be checked." }] } }))
      .toEqual({ verdict: "unknown", reason: "Peanut could not be checked." });
  });

  it("keeps a preview with a substituted line unknown, and its own lines clear", () => {
    expect(candidateRuleMark(eligible, pinned.ingredients.map(lineFor))).toBeNull();
    const [first, second] = pinned.ingredients.map(lineFor);
    expect(candidateRuleMark(eligible, [first, { ...second, name: "peanuts" }]))
      .toMatchObject({ verdict: "unknown" });
  });

  it("fails closed to unknown when the eligibility cannot be read", () => {
    const hostile = Object.defineProperty({ ...pinned }, "eligibility", {
      get() { throw new Error("bad"); } }) as RecipeCandidate;
    expect(candidateRuleMark(hostile)).toMatchObject({ verdict: "unknown" });
  });
});

describe("acceptedSelectionRuleMark (accept POST)", () => {
  const selection = { id: "s", recipeRevisionId: "rev",
    ingredientSnapshot: pinned.ingredients.map(lineFor) };

  it("clears the written selection under the current rules and names the flags", async () => {
    expect(await acceptedSelectionRuleMark(client, "account", selection))
      .toEqual({ ruleMark: null, preferenceFlags: [] });
  });

  it("is unknown when the pinned revision is missing or unreadable", async () => {
    mocks.recipes = [];
    expect((await acceptedSelectionRuleMark(client, "account", selection)).ruleMark)
      .toMatchObject({ verdict: "unknown" });
    mocks.pinnedError = new Error("down");
    expect((await acceptedSelectionRuleMark(client, "account", selection)).ruleMark)
      .toMatchObject({ verdict: "unknown" });
  });
});

describe("marked search and detail keep the recipe read apart from the rule read", () => {
  const search = { query: "", limit: 3 };

  it("marks a readable rule set from the current rules and names the flags", async () => {
    const found = await loadMarkedRecipeCandidates(client, "account", search);
    expect(found.candidates.map((row) => [row.revisionId, row.ruleMark])).toEqual([["rev", null]]);
    expect(found.rulesFingerprint).toEqual(expect.any(String));
    expect(found.preferenceFlags).toEqual([]);
    const detail = await loadMarkedRecipeDetail(client, "account", pinned.recipeId);
    expect(detail?.recipe.ruleMark).toBeNull();
    expect(detail?.preferenceFlags).toEqual([]);
  });

  it("returns the recipes marked unknown when the rule read fails, never a pass", async () => {
    mocks.policyError = new HttpError(500, "internal", "constraint read failed");
    const found = await loadMarkedRecipeCandidates(client, "account", search);
    expect(found.candidates.map((row) => row.revisionId)).toEqual(["rev"]);
    expect(found.candidates[0].ruleMark).toEqual({ verdict: "unknown",
      reason: "This recipe could not be checked against your current food rules." });
    expect(found.candidates[0].eligibility.status).toBe("unknown");
    expect(found.rulesFingerprint).toBeNull();
    expect(found).not.toHaveProperty("preferenceFlags");
    expect(found.noResultReasons[0]).toMatch(/could not be checked/);
    const detail = await loadMarkedRecipeDetail(client, "account", pinned.recipeId);
    expect(detail?.recipe.ruleMark?.verdict).toBe("unknown");
    expect(detail?.recipe.eligibility.status).toBe("unknown");
    expect(detail?.rulesFingerprint).toBeNull();
  });

  it("asks for a rule review when one is required, still returning the recipes", async () => {
    mocks.review = true;
    const found = await loadMarkedRecipeCandidates(client, "account", search);
    expect(found.candidates[0].ruleMark).toEqual({ verdict: "unknown",
      reason: "Review your food rules in Settings to check this recipe." });
  });

  it("keeps the recipe's own unknown when it is incomplete as well as unchecked", async () => {
    mocks.policyError = new Error("down");
    mocks.recipes = [{ ...pinned, steps: [] }];
    const detail = await loadMarkedRecipeDetail(client, "account", pinned.recipeId);
    expect(detail?.recipe.eligibility.reasons.map((reason) => reason.code))
      .toEqual(expect.arrayContaining(["incomplete_recipe", "rules_unavailable"]));
    expect(detail?.recipe.ruleMark?.verdict).toBe("unknown");
  });

  it("still fails the request when the recipe read itself fails", async () => {
    mocks.searchError = new Error("catalog down");
    await expect(loadMarkedRecipeCandidates(client, "account", search)).rejects.toThrow("catalog down");
    await expect(loadMarkedRecipeDetail(client, "account", pinned.recipeId)).rejects.toThrow("catalog down");
  });
});
