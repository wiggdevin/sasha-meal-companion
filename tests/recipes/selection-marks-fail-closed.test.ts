/**
 * Review round 5 BLOCK: every failure while marking an accepted selection leaves it unknown. A clear
 * (null) is written only after the eligibility verdict AND the snapshot check have both returned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import type { CatalogRecipe } from "@/lib/recipe-catalog/types";
import { ingredient, recipe } from "./fixture";

const mocks = vi.hoisted(() => ({ recipes: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/recipe-catalog/repository", () => ({
  getPinnedRecipeRevisions: vi.fn(async () => mocks.recipes),
  getCatalogRecipe: vi.fn(), searchCatalog: vi.fn(),
}));
vi.mock("@/lib/server/constraints", () => ({ getRuleReviewStatus: vi.fn(async () => ({ required: false })) }));
vi.mock("@/lib/server/policy-profile", () => ({
  readPolicyProfile: vi.fn(async () => ({ profile: EMPTY_PROFILE, rev: 1, instances: [] })),
}));
vi.mock("@/lib/server/recipe-pilot-identity", () => ({ resolvePilotCatalogRevisions: vi.fn(async () => new Map()) }));
vi.mock("@/lib/server/allergen-evidence", () => ({
  readAllergenEvidence: vi.fn(async () => new Map()), readAllergenChecks: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/foods/facets", () => ({ readFacets: vi.fn(async () => new Map()), facetCacheKey: () => "none" }));

const { acceptedSelectionRuleMarks } = await import("@/lib/server/recipe-candidates");

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
const lineFor = (item: CatalogRecipe["ingredients"][number]) => ({ seq: item.seq, name: item.name,
  foodRefId: item.foodRefId, foodDbId: item.foodDbId ?? null, foodRevisionId: item.catalogFoodRevisionId });
const markFor = async (ingredientSnapshot: unknown[] | undefined) =>
  (await acceptedSelectionRuleMarks(client, "account",
    [{ id: "s", recipeRevisionId: "rev", ingredientSnapshot }])).get("s");

beforeEach(() => { mocks.recipes = [pinned]; });

describe("accepted selection marks fail closed", () => {
  it("clears only a fully eligible recipe whose snapshot is its own lines", async () => {
    expect(await markFor(pinned.ingredients.map(lineFor))).toBeNull();
  });

  it("is unknown when a snapshot line throws while it is read", async () => {
    const hostile = Object.defineProperty({ seq: 1 }, "name", { get() { throw new Error("bad line"); } });
    expect(await markFor([hostile])).toMatchObject({ verdict: "unknown" });
  });

  it("is unknown for a substituted line, a nameless line or a mistyped identity", async () => {
    const [first, second] = pinned.ingredients.map(lineFor);
    expect(await markFor([first, { ...second, name: "peanuts" }])).toMatchObject({ verdict: "unknown" });
    expect(await markFor([first, { ...second, name: undefined }])).toMatchObject({ verdict: "unknown" });
    expect(await markFor([first, { ...second, foodRefId: 42 }])).toMatchObject({ verdict: "unknown" });
    expect(await markFor([first, { ...second, foodRevisionId: 999 }])).toMatchObject({ verdict: "unknown" });
  });

  it("is unknown when a pinned ingredient has no name, instead of throwing to a clear", async () => {
    const broken = { ...pinned, ingredients: [...pinned.ingredients,
      { ...ingredient({ seq: 3, name: "x" }), name: undefined as unknown as string }] };
    mocks.recipes = [broken];
    // The plan holds that nameless line too: it cannot be tied to a judged line, so no clear.
    expect(await markFor(broken.ingredients.map(lineFor))).toMatchObject({ verdict: "unknown" });
  });

  it("is unknown when the recipe itself cannot be judged", async () => {
    mocks.recipes = [Object.defineProperty({ ...pinned }, "ingredients", {
      get() { throw new Error("unreadable"); } })];
    expect(await markFor(pinned.ingredients.map(lineFor))).toMatchObject({ verdict: "unknown" });
  });
});
