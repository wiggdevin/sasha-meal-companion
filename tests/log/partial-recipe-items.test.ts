/** #21: an item logged from a saved recipe with unmeasured ingredients is named as partial. */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { judgePartialItems, partialRecipeCoverageByRef, partialRecipeItems } from "@/lib/server/log-recipe-coverage";

type Rows = Record<string, Record<string, unknown>[]>;

const marksOf = async (...args: Parameters<typeof partialRecipeItems>) =>
  (await partialRecipeItems(...args)).marks;

/** A minimal `.from(table).select(...).in("id", ids)` double over fixed rows. */
function db(rows: Rows, failing?: string): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => ({
        in: async (_column: string, ids: string[]) => failing === table
          ? { data: null, error: new Error(`${table} unreadable`) }
          : { data: (rows[table] ?? []).filter((row) => ids.includes(row.id as string)), error: null },
      }),
    }),
  } as unknown as SupabaseClient;
}

const rows: Rows = {
  food_refs: [
    { id: "ref-partial", user_food_id: "recipe-partial" },
    { id: "ref-whole", user_food_id: "recipe-whole" },
    { id: "ref-catalog", user_food_id: null },
    { id: "ref-custom", user_food_id: "custom-food" },
  ],
  recipes: [
    { id: "recipe-partial", rev: 2, recipe_revisions: [
      { rev: 1, nutrients_per_serving: { energy_kcal: 80, coverage: 1 } },
      { rev: 2, nutrients_per_serving: { energy_kcal: 50, coverage: 0.5 } }] },
    { id: "recipe-whole", rev: 1, recipe_revisions: [
      { rev: 1, nutrients_per_serving: { energy_kcal: 200, coverage: 1 } }] },
  ],
};

describe("partialRecipeItems", () => {
  it("names only items whose recipe's current revision is partly measured", async () => {
    const marks = await marksOf(db(rows), [
      { food_ref_id: "ref-catalog" }, { food_ref_id: "ref-partial" },
      { food_ref_id: "ref-whole" }, { food_ref_id: "ref-custom" }]);
    expect(marks).toEqual([{ path: "items.1", item_id: null, seq: null, food_ref_id: "ref-partial",
      coverage: 0.5, source: "derived" }]);
  });

  it("treats a recipe with no stored coverage as partial, never complete", async () => {
    const marks = await marksOf(db({ ...rows, recipes: [{ id: "recipe-whole", rev: 1,
      recipe_revisions: [{ rev: 1, nutrients_per_serving: { energy_kcal: 200 } }] }] }),
    [{ food_ref_id: "ref-whole" }]);
    expect(marks).toEqual([{ path: "items.0", item_id: null, seq: null, food_ref_id: "ref-whole",
      coverage: 0, source: "derived" }]);
  });

  it("asks nothing for an entry with no user foods", async () => {
    expect(await marksOf(db(rows, "recipes"), [{ food_ref_id: "ref-catalog" }])).toEqual([]);
  });

  it("carries the stored item's id and seq so the mark survives reordering", async () => {
    const marks = await marksOf(db(rows), [{ id: "item-9", seq: 3, food_ref_id: "ref-partial" }]);
    expect(marks).toEqual([{ path: "items.0", item_id: "item-9", seq: 3, food_ref_id: "ref-partial",
      coverage: 0.5, source: "derived" }]);
  });

  it("marks only the user foods unchecked, never failing the stored meal, when the recipe read fails", async () => {
    const marks = await marksOf(db(rows, "recipes"), [{ food_ref_id: "ref-partial" },
      { food_ref_id: "ref-catalog" }]);
    expect(marks.map((m) => [m.food_ref_id, m.source])).toEqual([["ref-partial", "unchecked"]]);
  });

  it("never marks a custom food, even when the recipe read fails", async () => {
    const withKinds = { ...rows, food_refs: [
      { id: "ref-partial", user_food_id: "recipe-partial", user_foods: { kind: "recipe" } },
      { id: "ref-custom", user_food_id: "custom-food", user_foods: { kind: "custom" } }] };
    const marks = await marksOf(db(withKinds, "recipes"), [{ food_ref_id: "ref-partial" },
      { food_ref_id: "ref-custom" }]);
    expect(marks.map((m) => [m.food_ref_id, m.source])).toEqual([["ref-partial", "unchecked"]]);
  });

  it("calls no item partial when even the food_refs read fails: the entry is unchecked instead", async () => {
    // A catalog food cannot be told from a recipe twin without that read, so nothing is marked.
    const answer = await partialRecipeItems(db(rows, "food_refs"), [{ food_ref_id: "ref-partial" },
      { food_ref_id: "ref-catalog" }, { food_ref_id: "ref-whole", nutrition_partial: true }]);
    expect(answer.unchecked).toBe(true);
    // A recorded flag still speaks: it needed no read.
    expect(answer.marks.map((m) => [m.food_ref_id, m.source])).toEqual([["ref-whole", "recorded"]]);
  });

  it("the shared lookup throws on a failed read so the export cannot print a partial as whole", async () => {
    await expect(partialRecipeCoverageByRef(db(rows, "recipes"), ["ref-partial"]))
      .rejects.toThrow("recipe coverage unreadable");
    await expect(judgePartialItems(db(rows, "recipes"), [{ food_ref_id: "ref-partial" }],
      { onError: "throw" })).rejects.toThrow("recipes unreadable");
    expect(await partialRecipeCoverageByRef(db(rows), ["ref-partial", "ref-whole"]))
      .toEqual(new Map([["ref-partial", 0.5]]));
  });
});

describe("the recorded flag decides before the current revision (round 3, BLOCK 1)", () => {
  it("keeps a serving recorded partial even after its recipe was completed", async () => {
    // ref-whole's recipe is at coverage 1 NOW; the item was written while it was partial.
    const judged = await judgePartialItems(db(rows), [
      { food_ref_id: "ref-whole", nutrition_partial: true },
      { food_ref_id: "ref-partial", nutrition_partial: false },
      { food_ref_id: "ref-partial", nutrition_partial: null },
      { food_ref_id: "ref-catalog" }], { onError: "throw" });
    expect(judged).toEqual([{ source: "recorded", coverage: null }, null,
      { source: "derived", coverage: 0.5 }, null]);
  });

  it("asks nothing when every item carries a recorded flag", async () => {
    // A failing recipes table proves no fallback read happens.
    expect(await judgePartialItems(db(rows, "recipes"),
      [{ food_ref_id: "ref-partial", nutrition_partial: true }], { onError: "throw" }))
      .toEqual([{ source: "recorded", coverage: null }]);
  });

  it("an older revision never stands in for a missing current one", async () => {
    const stale = { ...rows, recipes: [{ id: "recipe-partial", rev: 3, recipe_revisions: [
      { rev: 1, nutrients_per_serving: { coverage: 1 } }] }] };
    expect(await partialRecipeCoverageByRef(db(stale), ["ref-partial"]))
      .toEqual(new Map([["ref-partial", 0]]));
  });

  it("marks recorded items in the commit answer with their source", async () => {
    expect(await marksOf(db(rows), [{ id: "i1", seq: 0, food_ref_id: "ref-whole",
      nutrition_partial: true }])).toEqual([{ path: "items.0", item_id: "i1", seq: 0,
      food_ref_id: "ref-whole", coverage: null, source: "recorded" }]);
  });
});
