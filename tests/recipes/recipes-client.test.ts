import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { allOps, getRow } from "@/lib/sync/idb";
import { putRevision } from "@/lib/db/catalog-cache";
import { deleteRecipe, listRecipes, provisionalNutrients, recipeFoodRefId, recipeServingNutrition,
  saveRecipe } from "@/lib/recipes-client";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const rice = { seq: 1, foodRefId: "ref-rice", qty: 1, unit: "g", grams: 400,
  state: "cooked" as const, foodRevisionId: 11 };

beforeEach(async () => { h = await resetTestAccount(); globalThis.indexedDB = new IDBFactory(); });

describe("saveRecipe", () => {
  it("writes the local row and enqueues a create with a snake_case payload", async () => {
    const { recipeId, rev } = await saveRecipe({ name: "Rice tray", servings: 4, items: [rice] });
    expect(rev).toBe(1);
    const row = await getRow(h, "recipes", recipeId);
    expect(row).toMatchObject({ id: recipeId, name: "Rice tray", servings: 4, rev: 1 });
    const [op] = await allOps(h);
    expect(op).toMatchObject({ entity: "recipes", entity_id: recipeId, kind: "create", base_rev: null });
    expect(op.payload.items).toEqual([{ seq: 1, food_ref_id: "ref-rice", qty: 1, unit: "g",
      grams: 400, state: "cooked", food_revision_id: 11 }]);
  });

  it("enqueues an update carrying base_rev when she edits a saved recipe", async () => {
    const first = await saveRecipe({ name: "Rice tray", servings: 4, items: [rice] });
    const second = await saveRecipe({ id: first.recipeId, baseRev: 1, name: "Rice tray",
      servings: 8, items: [rice] });
    expect(second.rev).toBe(2);
    const ops = await allOps(h);
    expect(ops[1]).toMatchObject({ kind: "update", base_rev: 1 });
  });

  it("lists saved recipes by name and skips tombstones", async () => {
    await saveRecipe({ name: "Zucchini bake", servings: 2, items: [rice] });
    await saveRecipe({ name: "Apple-free crumble", servings: 2, items: [rice] });
    expect((await listRecipes()).map((r) => r.name))
      .toEqual(["Apple-free crumble", "Zucchini bake"]);
  });

  it("removes an account recipe with a tombstone and a revision-bound delete op", async () => {
    const { recipeId } = await saveRecipe({ name: "Rice tray", servings: 4, items: [rice] });
    const [recipe] = await listRecipes();
    await deleteRecipe(recipe);
    expect(await listRecipes()).toEqual([]);
    expect(await getRow(h, "recipes", recipeId)).toMatchObject({ id: recipeId, rev: 2 });
    const ops = await allOps(h);
    expect(ops.at(-1)).toMatchObject({ entity: "recipes", entity_id: recipeId,
      kind: "delete", base_rev: 1, payload: {} });
  });

  it("refuses removal from an older edit sheet and preserves the newer recipe", async () => {
    const first = await saveRecipe({ name: "Rice tray", servings: 4, items: [rice] });
    const [stale] = await listRecipes();
    await saveRecipe({ id: first.recipeId, baseRev: stale.rev, name: "Rice tray revised",
      servings: 8, items: [rice] });
    const opsBefore = (await allOps(h)).length;
    await expect(deleteRecipe(stale)).rejects.toThrow("This recipe changed");
    expect((await listRecipes())[0]).toMatchObject({ name: "Rice tray revised", rev: 2 });
    expect((await allOps(h)).length).toBe(opsBefore);
  });
});

describe("provisionalNutrients and recipeFoodRefId", () => {
  it("reads per-100 g from the catalog cache", async () => {
    await putRevision({ revision_id: 11, catalog_food_id: 1, description: "Rice", brand: null,
      source: "fdc_sr_legacy", version_label: "v1", portions: [], cached_at: new Date().toISOString(),
      per_100g: { energy_kcal: 130, protein: 2.7, carbohydrate: 28, fat_total: 0.3, fiber_total: 0.4 } });
    const { perServing, coverage } = await provisionalNutrients([rice], 4);
    expect([perServing.energy_kcal, coverage]).toEqual([130, 1]);
  });

  it("has no food ref until the server answers", async () => {
    const { recipeId } = await saveRecipe({ name: "Rice tray", servings: 4, items: [rice] });
    expect(await recipeFoodRefId(recipeId)).toBeNull();
  });
});

describe("recipeServingNutrition (#21)", () => {
  it("hands the card the kcal and says when it is only a partial count", () => {
    expect(recipeServingNutrition({ nutrients_per_serving: { energy_kcal: 50, coverage: 0.5 } }))
      .toEqual({ kcal: 50, coverage: 0.5, nutritionComplete: false });
    expect(recipeServingNutrition({ nutrients_per_serving: { energy_kcal: 212.5, coverage: 1 } }))
      .toEqual({ kcal: 212.5, coverage: 1, nutritionComplete: true });
    expect(recipeServingNutrition({ nutrients_per_serving: { energy_kcal: null, coverage: 0 } }))
      .toEqual({ kcal: null, coverage: 0, nutritionComplete: false });
  });
});
