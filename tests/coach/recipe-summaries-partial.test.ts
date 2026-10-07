/** #21: the coach's recipe summaries say when a recipe's per-serving figures are partial. */
import { describe, expect, it } from "vitest";
import { recipeSummaries } from "@/lib/server/coach-context";
import { db } from "./context-fixtures";

describe("recipe summaries and partial nutrition", () => {
  it("never reports a recipe complete from an older revision standing in for the current one", async () => {
    const client = db({
      recipes: [{ id: "r3", name: "Edited stew", servings: 2, rev: 3, recipe_revisions: [
        { rev: 1, nutrients_per_serving: { energy_kcal: 300, coverage: 1 }, recipe_items: [] },
      ] }],
    });
    const { recipes } = await recipeSummaries(client, "u1");
    expect(recipes[0]).toMatchObject({ coverage: 0, nutritionComplete: false });
  });

  it("marks a partial recipe's per-serving figures as partial", async () => {
    const client = db({
      recipes: [{ id: "r2", name: "Half-known stew", servings: 2, rev: 1, recipe_revisions: [
        { rev: 1, nutrients_per_serving: { energy_kcal: 50, coverage: 0.5 }, recipe_items: [] },
      ] }],
    });
    const { recipes } = await recipeSummaries(client, "u1");
    expect(recipes[0]).toMatchObject({ perServing: { kcal: 50 }, coverage: 0.5, nutritionComplete: false });
  });
});
