import { describe, expect, it } from "vitest";
import { hydrateResolvedTool } from "@/lib/coach/blocks";
import { hydrateFoodSearch } from "@/lib/coach/blocks/hydrate-food-search";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const hit = (index: number, overrides: Record<string, unknown> = {}) => ({
  foodRefId: `ref-${index}`,
  catalogFoodRevisionId: 70 + index,
  name: `Rice ${index}`,
  brand: null,
  kcalPer100g: 130,
  prefStatus: null,
  allergenTags: [],
  category: [],
  ...overrides,
});

describe("food search block hydration", () => {
  it("derives membership and blocked state from server evidence", () => {
    expect(hydrateFoodSearch("search-1", {
      query: "cheese", intent: "avoid", limit: 10,
    }, [hit(1, { name: "Cheese", prefStatus: "eats", allergenTags: ["dairy"] })],
    DEFAULT_PROFILE)).toEqual({
      kind: "food_search", v: 1, id: "search-1", query: "cheese", intent: "avoid",
      results: [{
        foodRefId: "ref-1", revisionId: "71", name: "Cheese", kcalPer100g: 130,
        status: "eats", blocked: true,
      }],
      truncated: false,
    });
  });

  it("trims the look-ahead row and marks the block truncated", () => {
    const block = hydrateFoodSearch("search-2", {
      query: "rice", intent: "browse", limit: 2,
    }, [hit(1), hit(2), hit(3)], DEFAULT_PROFILE);
    expect(block?.results.map((row) => row.name)).toEqual(["Rice 1", "Rice 2"]);
    expect(block?.truncated).toBe(true);
  });

  it("ignores model-supplied result data", () => {
    const args = {
      query: "rice", intent: "eats", limit: 2,
      results: [{ foodRefId: "model", revisionId: "model", name: "Invented" }],
    } as const;
    expect(hydrateFoodSearch("search-3", args, [hit(1)], DEFAULT_PROFILE)?.results)
      .toEqual([{ foodRefId: "ref-1", revisionId: "71", name: "Rice 1", kcalPer100g: 130,
        status: "neutral", blocked: false }]);
  });

  it("returns no block when the catalog returned no usable refs", () => {
    expect(hydrateFoodSearch("search-4", { query: "x", intent: "browse" }, [
      hit(1, { foodRefId: null }),
    ], DEFAULT_PROFILE)).toBeNull();
  });

  it("creates a block only for an explicit user-facing search intent", () => {
    const ctx = {
      admin: {} as never, userId: "user-1", date: "2026-09-19", tz: "America/Denver",
      context: null, profile: DEFAULT_PROFILE, newId: () => "search-5",
    };
    const browse = hydrateResolvedTool(
      "search_foods", { query: "rice", intent: "browse" }, [hit(1)], ctx,
    );
    const lookup = hydrateResolvedTool(
      "search_foods", { query: "rice", intent: "lookup" }, [hit(1)], ctx,
    );
    const omitted = hydrateResolvedTool(
      "search_foods", { query: "rice" }, [hit(1)], ctx,
    );

    expect(browse.block).toMatchObject({ kind: "food_search", intent: "log" });
    expect(browse.data).toEqual({
      ok: true, block: "food_search", matches: 1,
      names: ["Rice 1"], statusCounts: { eats: 0, avoid: 0, neutral: 1 },
    });
    expect(lookup).toMatchObject({ block: null, data: [expect.objectContaining({ name: "Rice 1" })] });
    expect(omitted).toMatchObject({ block: null, data: [expect.objectContaining({ name: "Rice 1" })] });
  });
});
