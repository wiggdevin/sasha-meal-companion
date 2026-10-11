import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import { cuisineSearchPattern, normalizeCuisineFamily } from "./cuisine";
import { searchCatalog } from "./repository";
import { ingredient, recipe } from "@/tests/recipes/fixture";

describe("cuisine family", () => {
  it("folds case, spacing, dashes and the -inspired suffix into one family", () => {
    expect(normalizeCuisineFamily(" Italian-inspired ")).toBe("italian");
    expect(normalizeCuisineFamily("Italian inspired")).toBe("italian");
    expect(normalizeCuisineFamily("ITALIAN")).toBe("italian");
    expect(normalizeCuisineFamily("Middle–Eastern")).toBe("middle eastern");
    expect(normalizeCuisineFamily("middle  eastern")).toBe("middle eastern");
  });

  it("invents no synonym: a different family stays different", () => {
    expect(normalizeCuisineFamily("Tuscan")).toBe("tuscan");
    expect(normalizeCuisineFamily("Chinese")).toBe("chinese");
    expect(normalizeCuisineFamily("inspired")).toBe("inspired");
  });

  it("builds a contains pattern that carries no caller wildcard", () => {
    expect(cuisineSearchPattern("Italian")).toBe("%italian%");
    expect(cuisineSearchPattern("Middle-Eastern")).toBe("%middle%eastern%");
    expect(cuisineSearchPattern("50%_off")).toBe("%50%off%");
  });
});

type Call = { table: string; method: string; args: unknown[] };

/** Just the PostgREST surface `searchCatalog` uses; every chained call is recorded. */
function catalogClient(revisions: Record<string, unknown>[]) {
  const calls: Call[] = [];
  const from = (table: string) => {
    // W038: the scan first reads the published recipes' current revision ids.
    const answer = table === "recipe_catalog_revisions" ? revisions
      : table === "recipe_catalog" ? [{ id: "recipe-1", current_revision_id: "rev-1" }] : [];
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "order", "range", "textSearch", "ilike", "lte", "eq", "in", "not"]) {
      chain[method] = (...args: unknown[]) => { calls.push({ table, method, args }); return chain; };
    }
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: answer, error: null }).then(resolve);
    return chain;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

describe("searchCatalog cuisine predicate", () => {
  it("asks the database for the cuisine family as a contains match, not an exact one", async () => {
    const { client, calls } = catalogClient([]);
    await searchCatalog(client, { query: "", cuisine: "Italian" });
    expect(calls.filter((call) => call.method === "ilike"))
      .toEqual([{ table: "recipe_catalog_revisions", method: "ilike", args: ["cuisine", "%italian%"] }]);
  });

  it("returns an empty collection when no row matches, never an error", async () => {
    const { client } = catalogClient([]);
    await expect(searchCatalog(client, { query: "", cuisine: "Chinese" })).resolves.toEqual([]);
  });
});

describe("cuisine family through candidate search", () => {
  const italianInspired = recipe({ recipeId: "pasta", revisionId: "pasta-v1",
    name: "Tomato pasta", cuisine: "Italian-inspired", dishTags: ["pasta"] });

  it("lets an Italian request return an eligible Italian-inspired recipe", () => {
    const found = findRecipeCandidates([italianInspired], { query: "", cuisine: "Italian" },
      { profile: EMPTY_PROFILE });
    expect(found.candidates.map((row) => row.recipeId)).toEqual(["pasta"]);
  });

  it("matches a request written as the family with the suffix", () => {
    const plain = recipe({ recipeId: "risotto", revisionId: "risotto-v1",
      name: "Risotto", cuisine: "Italian", dishTags: ["rice"] });
    const found = findRecipeCandidates([plain], { query: "", cuisine: "Italian-inspired" },
      { profile: EMPTY_PROFILE });
    expect(found.candidates.map((row) => row.recipeId)).toEqual(["risotto"]);
  });

  it("answers a Chinese request with no eligible rows as a plain empty result", () => {
    const found = findRecipeCandidates([italianInspired], { query: "", cuisine: "Chinese" },
      { profile: EMPTY_PROFILE });
    expect(found.candidates).toEqual([]);
    expect(found.noResultReasons.join(" ")).not.toMatch(/cannot_match_any_requests/);
    expect(found.noResultReasons).toEqual([
      "No complete recipe matches the requested dish, cuisine, time, and effort."]);
  });

  it("still excludes a family match that contains an Avoid ingredient", () => {
    const withAvoided = recipe({ recipeId: "garlic-pasta", revisionId: "garlic-pasta-v1",
      name: "Garlic pasta", cuisine: "Italian-inspired", dishTags: ["pasta"],
      ingredients: [ingredient({ seq: 1, name: "pasta" }),
        ingredient({ seq: 2, name: "garlic", foodRefId: "ref-garlic" })] });
    const found = findRecipeCandidates([withAvoided, italianInspired],
      { query: "", cuisine: "Italian" },
      { profile: EMPTY_PROFILE, explicitAvoidFoodRefIds: ["ref-garlic"] });
    expect(found.candidates.map((row) => row.recipeId)).toEqual(["pasta"]);
    expect(found.excluded.map((row) => row.revisionId)).toEqual(["garlic-pasta-v1"]);
  });
});
