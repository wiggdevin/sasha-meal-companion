// @vitest-environment jsdom
/**
 * T1, 2026-09-12: with the catalog off, a recipe ingredient has to come from the bundled list.
 * `recipe_items.food_ref_id` is a required FK, so a bundled food is adopted (one `user_foods` row
 * plus its `food_refs` row) before it can be saved. `@testing-library/react` is not installed and
 * no dependency may be added (contracts §1), so the tap itself stays a manual phone gate: the
 * pick-to-items transition is a pure, injectable function (lib/recipes/recipe-sheet-state.ts) and
 * that is what these cases drive — for the flag-off bundled pick and the flag-on offline-tier row
 * alike — through to `canSave` and the payload the sheet hands `saveRecipe`.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RecipeFoodSearch from "@/components/RecipeFoodSearch";
import RecipeSheet from "@/components/RecipeSheet";
import type { CatalogRow } from "@/lib/catalog-client";
import { dbFood, searchFoods } from "@/lib/food-db";
import { adoptedSnapshot, bundledFoodUserId, per100gFromBundled,
  rememberAdopted } from "@/lib/foods/adopt-client";
import {
  ADD_FAILED_COPY, addIngredient, addIngredientInto, canSave, pickFromCatalogRow,
  offPlanCopy, recipeSaveInput, type PickDeps, type SheetState,
} from "@/lib/recipes/recipe-sheet-state";
import { draftFromWire, runLiveStrip, runSave, SAVE_FAILED_COPY, seededDraft, STRIP_FAILED_COPY }
  from "@/lib/recipes/use-recipe-sheet";
import { provisionalNutrients, saveRecipe } from "@/lib/recipes-client";
import { allOps, getRow } from "@/lib/sync/idb";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

vi.mock("@/components/Sheet", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/CatalogSearch", () => ({ default: () => <div data-testid="catalog-search" /> }));

/** `saveRecipe` is stubbed so a case can assert what the sheet hands it; the real one is kept
 *  beside it to prove the wire payload does not grow a client-only field. */
const mocks = vi.hoisted(() => ({
  saveRecipe: vi.fn<(input: Record<string, unknown>) =>
    Promise<{ recipeId: string; rev: number }>>(async () => ({ recipeId: "r-new", rev: 1 })),
}));
vi.mock("@/lib/recipes-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/recipes-client")>();
  return { ...actual, saveRecipe: mocks.saveRecipe, realSaveRecipe: actual.saveRecipe };
});

const CHICKEN = "chicken-breast-roasted";
const THIGH = "chicken-thigh-roasted";
/** One food per off-plan flag, straight out of the bundled list's own `flags`. */
const GLUTEN_FOOD = "fish-sticks";
const DAIRY_FOOD = "whole-milk";
const APPLE_FOOD = "apple-with-skin";
const OFF_PLAN = [
  { flag: "gluten", bundledId: GLUTEN_FOOD },
  { flag: "dairy", bundledId: DAIRY_FOOD },
  { flag: "apple", bundledId: APPLE_FOOD },
] as const;

/** The three the sheet injects, with the adoption stubbed to what the server would answer. */
function deps(over: Partial<PickDeps> = {}): PickDeps {
  return {
    adopt: async (id) => ({ foodRefId: `ref-${id}`, per100g: per100gFromBundled(dbFood(id)!) }),
    resolveRef: async (catalogFoodId) => `ref-catalog-${catalogFoodId}`,
    food: dbFood,
    ...over,
  };
}

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The offline tier of the catalog picker: a bundled hit wearing a catalog row. */
const offlineRow: CatalogRow = {
  key: `offline:db:${CHICKEN}`, catalogFoodId: null, revisionId: null,
  description: "Chicken breast, roasted", brand: null, sourceTile: "USDA", qualityFlags: [],
  prefStatus: null, score: 12, offline: true, offPlan: [], offlineFoodId: CHICKEN,
  offlineSource: "db",
};

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
  mocks.saveRecipe.mockClear();
});
afterEach(async () => {
  cleanup();
  h = await resetTestAccount();
  delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
});

describe("a bundled food as a recipe ingredient", () => {
  it("maps the bundled per-100 g keys onto the nutrient codes the app stores", () => {
    expect(per100gFromBundled(dbFood(CHICKEN)!)).toEqual({
      energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6, fiber_total: 0,
    });
  });

  it("mints one stable version-5 user_foods id per bundled food", async () => {
    // uuid5(NAMESPACE_DNS, "bundled:<id>") — repeats land on the same row, never a second copy.
    const id = await bundledFoodUserId(CHICKEN);
    expect(id).toBe("82edd001-2a46-52cc-8559-9372c6f2afb1");
    expect(await bundledFoodUserId(CHICKEN)).toBe(id);
    expect(await bundledFoodUserId(THIGH)).not.toBe(id);
    expect(id[14]).toBe("5");
    expect("89ab").toContain(id[19]);
  });

  it("appends a picked bundled food, enables Save, and hands the item to saveRecipe", async () => {
    const state = await addIngredient({ items: [], notice: null },
      { source: "bundled", bundledId: CHICKEN }, deps());

    expect(state.notice).toBeNull();
    expect(state.items).toEqual([{
      seq: 1, foodRefId: `ref-${CHICKEN}`, name: "Chicken breast, roasted",
      qty: 1, unit: "g", grams: 100, state: "cooked", foodRevisionId: null,
      per100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6, fiber_total: 0 },
    }]);
    expect(canSave(state.items, false, "Chicken tray")).toBe(true);
    // A blank or whitespace name never saves: it produced a nameless card on Foods (2026-09-22).
    expect(canSave(state.items, false, "")).toBe(false);
    expect(canSave(state.items, false, "   ")).toBe(false);
    expect(recipeSaveInput({ items: state.items, name: "  Chicken tray  ", servings: 1,
      yieldGrams: null }).name).toBe("Chicken tray");

    const input = recipeSaveInput({ items: state.items, name: "Chicken tray", servings: 1,
      yieldGrams: null });
    await saveRecipe(input);
    expect(mocks.saveRecipe).toHaveBeenCalledTimes(1);
    expect(mocks.saveRecipe.mock.calls[0][0]).toBe(input);
    expect(input.items[0]).toMatchObject({ seq: 1, foodRefId: `ref-${CHICKEN}` });
  });

  it("appends an offline-tier catalog row through the same transition", async () => {
    const state = await addIngredient({ items: [], notice: null },
      pickFromCatalogRow(offlineRow), deps());

    expect(pickFromCatalogRow(offlineRow)).toMatchObject({ source: "offline", bundledId: CHICKEN,
      offPlan: [] });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      seq: 1, foodRefId: `ref-${CHICKEN}`, name: "Chicken breast, roasted",
      per100g: { energy_kcal: 165, protein: 31 },
    });
    expect(canSave(state.items, false, "Chicken tray")).toBe(true);

    await saveRecipe(recipeSaveInput({ items: state.items, name: "Tray", servings: 2,
      yieldGrams: 400 }));
    const handed = mocks.saveRecipe.mock.calls[0][0] as { items: unknown[] };
    expect(handed.items).toHaveLength(1);
  });

  it("shows the inline line and adds nothing when adoption is refused", async () => {
    const before: SheetState = { items: [], notice: null };
    const refused = await addIngredient(before, { source: "bundled", bundledId: CHICKEN },
      deps({ adopt: async () => null }));

    expect(refused).toEqual({ items: [], notice: ADD_FAILED_COPY });
    expect(ADD_FAILED_COPY).toBe("Can't add this one right now");
    expect(canSave(refused.items, false, "Chicken tray")).toBe(false);
    expect(mocks.saveRecipe).not.toHaveBeenCalled();

    // A row with no bundled id (a "mine" hit, or an offline row the DB does not hold) reads the
    // same way: the line, never a silent return.
    const unknown = await addIngredient(before, { source: "offline", bundledId: null }, deps());
    expect(unknown).toEqual({ items: [], notice: ADD_FAILED_COPY });
  });

  it("says which flags refused the tap, in both tiers, for apple, gluten and dairy (R6)", async () => {
    // A recipe is a meal the user plans, so the domain rule binds it: the row stays visible and
    // marked, and tapping it shows the line instead of adding. Logging stays permissive.
    expect(offPlanCopy(["gluten"])).toBe("Not on their plan (gluten)");
    expect(offPlanCopy(["gluten", "dairy"])).toBe("Not on their plan (gluten and dairy)");
    expect(offPlanCopy(["apple", "gluten", "dairy"])).toBe("Not on their plan (apple, gluten and dairy)");

    const before: SheetState = { items: [], notice: null };
    for (const { flag, bundledId } of OFF_PLAN) {
      // The bundled list's own flag — the catalog-off tier.
      expect(dbFood(bundledId)!.flags).toContain(flag);
      let adoptions = 0;
      const bundled = await addIngredient(before, { source: "bundled", bundledId },
        deps({ adopt: async (id) => {
          adoptions += 1;
          return { foodRefId: `ref-${id}`, per100g: per100gFromBundled(dbFood(id)!) };
        } }));
      // Nothing adopted and nothing added: the flags refuse the tap before the row is written.
      expect(adoptions).toBe(0);
      expect(bundled).toEqual({ items: [], notice: `Not on their plan (${flag})` });

      // The offline tier of the catalog picker, refused server-side before its ref resolves.
      const row: CatalogRow = { ...offlineRow, key: `offline:db:${bundledId}`,
        description: dbFood(bundledId)!.name, offlineFoodId: bundledId, offPlan: [flag] };
      const catalog = await addIngredient(before, pickFromCatalogRow(row), deps());
      expect(catalog).toEqual({ items: [], notice: `Not on their plan (${flag})` });
      expect(canSave(catalog.items, false, "Chicken tray")).toBe(false);
    }
    expect(mocks.saveRecipe).not.toHaveBeenCalled();
  });

  it("refuses an off-plan live catalog row too", async () => {
    const row: CatalogRow = { ...offlineRow, key: "catalog:1", catalogFoodId: 1, revisionId: 9,
      description: "Cheddar cheese", offline: false, offlineFoodId: undefined, offPlan: ["dairy"] };
    const state = await addIngredient({ items: [], notice: null }, pickFromCatalogRow(row), deps());
    expect(state).toEqual({ items: [], notice: "Not on their plan (dairy)" });
  });

  it("refuses a catalog row the user personally marked Avoid, even with no allergen or name match (gap-recipes-build-meal-7)", async () => {
    // A food the user avoids for a personal reason (an allergic reaction, not gluten/dairy/apple) has
    // no name-regex match and no allergen tag, so `offPlan` is empty — but their own Eats/Avoid
    // preference is real and the pill CatalogSearch shows for it must not be cosmetic only.
    const row: CatalogRow = { ...offlineRow, key: "catalog:2", catalogFoodId: 2, revisionId: 10,
      description: "Some food they reacted to", offline: false, offlineFoodId: undefined,
      prefStatus: "avoid", offPlan: [] };
    const state = await addIngredient({ items: [], notice: null }, pickFromCatalogRow(row), deps());
    expect(state.items).toHaveLength(0);
    expect(state.notice).not.toBeNull();
  });

  it("leaves an on-plan pick alone — the rule refuses the flagged one, not the list", async () => {
    const state = await addIngredient({ items: [], notice: null },
      { source: "bundled", bundledId: CHICKEN }, deps());
    expect(dbFood(CHICKEN)!.flags).toEqual([]);
    expect(state.items).toHaveLength(1);
    expect(state.notice).toBeNull();
  });

  it("keeps both ingredients, with unique seq, when two picks resolve out of order", async () => {
    // The sheet's own two lines: `addIngredientInto` resolves off-screen, then lands the outcome
    // through a functional update, so `applyPick` reads the items that are actually there.
    let sheet: SheetState = { items: [], notice: null };
    const update = (apply: (prev: SheetState) => SheetState) => { sheet = apply(sheet); };
    const slowAdopt: PickDeps = deps({ adopt: async (id) => {
      await delay(20);
      return { foodRefId: `ref-${id}`, per100g: per100gFromBundled(dbFood(id)!) };
    } });

    const slow = addIngredientInto(update, { source: "bundled", bundledId: THIGH }, slowAdopt);
    const fast = addIngredientInto(update, { source: "bundled", bundledId: CHICKEN }, deps());
    await Promise.all([slow, fast]);

    expect(sheet.items.map((item) => item.foodRefId))
      .toEqual([`ref-${CHICKEN}`, `ref-${THIGH}`]);
    expect(sheet.items.map((item) => item.seq)).toEqual([1, 2]);
    expect(new Set(sheet.items.map((item) => item.seq)).size).toBe(2);
    expect(canSave(sheet.items, false, "Chicken tray")).toBe(true);
  });

  it("reads the bundled numbers on the strip and the bundled name after a reopen", async () => {
    const state = await addIngredient({ items: [], notice: null },
      { source: "bundled", bundledId: CHICKEN }, deps());
    // The strip: no cached revision, but the item's own snapshot answers. 165 kcal, nothing
    // unmeasured — not the "0 kcal · some nutrients unmeasured" of an empty map.
    const { perServing, coverage } = await provisionalNutrients(state.items, 1);
    expect([perServing.energy_kcal, perServing.protein, coverage]).toEqual([165, 31, 1]);

    // Reopen: the saved wire item carries no name and no snapshot (the server row is unchanged),
    // so the adoption index is what puts the bundled name back.
    await rememberAdopted(h, `ref-${CHICKEN}`,
      { name: "Chicken breast, roasted", per100g: per100gFromBundled(dbFood(CHICKEN)!) });
    expect(await adoptedSnapshot(`ref-${CHICKEN}`)).toMatchObject({ name: "Chicken breast, roasted" });
    const wire = draftFromWire({ seq: 1, food_ref_id: `ref-${CHICKEN}`, qty: 1, unit: "g",
      grams: 100, state: "cooked", food_revision_id: null });
    expect(wire.name).toBe("Saved food");
    const seeded = await seededDraft(wire);
    expect(seeded.name).toBe("Chicken breast, roasted");
    expect((await provisionalNutrients([seeded], 1)).perServing.energy_kcal).toBe(165);
  });

  it("offers the bundled list, not the catalog search, when the catalog flag is unset", () => {
    const markup = renderToStaticMarkup(<RecipeSheet onClose={() => {}} onSaved={() => {}} />);
    expect(markup).toContain("e.g. chicken, banana, chkn brst");
    expect(markup).not.toContain('data-testid="catalog-search"');
  });

  it("recovers an offline-saved bundled draft on reopen and adds to it from the bundled list", async () => {
    await rememberAdopted(h, `ref-${CHICKEN}`,
      { name: "Chicken breast, roasted", per100g: per100gFromBundled(dbFood(CHICKEN)!) });
    render(<RecipeSheet onClose={() => {}} onSaved={() => {}} recipe={{
      id: "r-offline", name: "Chicken tray", servings: 1, yield_grams: null, rev: 1,
      items: [{ seq: 1, food_ref_id: `ref-${CHICKEN}`, qty: 1, unit: "g", grams: 100,
        state: "cooked", food_revision_id: null }],
      nutrients_per_serving: {},
    }} />);
    expect(await screen.findByText("Chicken breast, roasted")).toBeTruthy();
    expect(screen.queryByPlaceholderText("e.g. chicken, banana, chkn brst")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add ingredient" }));
    expect(screen.getByPlaceholderText("e.g. chicken, banana, chkn brst")).toBeTruthy();
    expect(screen.getByText("Chicken breast, roasted")).toBeTruthy();
    expect(screen.getByText(/^1 items · 100 g/)).toBeTruthy();
  });

  it("offers the catalog search once the flag is on", () => {
    process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
    const markup = renderToStaticMarkup(<RecipeSheet onClose={() => {}} onSaved={() => {}} />);
    expect(markup).toContain('data-testid="catalog-search"');
    expect(markup).not.toContain("e.g. chicken, banana, chkn brst");
  });

  it("shows no strip on an empty recipe", () => {
    const markup = renderToStaticMarkup(<RecipeSheet onClose={() => {}} onSaved={() => {}} />);
    expect(markup).toContain("Add what goes in it");
    expect(markup).not.toContain("kcal a serving");
    expect(markup).not.toContain("0 items");
  });

  it("lists the bundled matches for a typed query", () => {
    const hits = searchFoods("chicken", {});
    const markup = renderToStaticMarkup(
      <RecipeFoodSearch query="chicken" mine={{}} onQuery={() => {}} onPick={() => {}} />);
    expect(hits).toHaveLength(12);
    expect(markup).toContain(`>${hits[0].name}<`);
    // Marked, not hidden: a gluten-flagged bundled food still renders, with its flag said out
    // loud. The tap is what R6 refuses, and the transition tests below cover that.
    expect(markup).toContain("Chicken nuggets");
    expect(markup).toContain("off-plan: gluten");
    // One button per hit, plus the lookup field's own clear button once it holds a query.
    expect((markup.match(/<button/g) ?? []).length).toBe(hits.length + 1);
    expect(markup).toContain('aria-label="Clear search foods"');
  });
});

describe("the transition against the real recipe client", () => {
  it("keeps the snapshot out of the wire payload the server row is built from", async () => {
    const state = await addIngredient({ items: [], notice: null },
      { source: "bundled", bundledId: CHICKEN }, deps());
    expect(state.items[0].per100g).toBeDefined();

    const client = await import("@/lib/recipes-client") as unknown as {
      realSaveRecipe: typeof saveRecipe;
    };
    const { recipeId } = await client.realSaveRecipe(
      recipeSaveInput({ items: state.items, name: "Chicken tray", servings: 1, yieldGrams: null }));

    const row = await getRow(h, "recipes", recipeId);
    expect((row?.items as Record<string, unknown>[])[0]).toEqual({
      seq: 1, food_ref_id: `ref-${CHICKEN}`, qty: 1, unit: "g", grams: 100, state: "cooked",
      food_revision_id: null,
    });
    expect(JSON.stringify(await allOps(h))).not.toContain("per100g");
  });

  it("lands the strip on the local row's nutrients, not a zeroed one", async () => {
    const client = await import("@/lib/recipes-client") as unknown as {
      realSaveRecipe: typeof saveRecipe;
    };
    const state = await addIngredient({ items: [], notice: null },
      { source: "bundled", bundledId: CHICKEN }, deps());
    const { recipeId } = await client.realSaveRecipe(
      recipeSaveInput({ items: state.items, name: "Chicken tray", servings: 2, yieldGrams: null }));
    const row = await getRow(h, "recipes", recipeId);
    expect((row?.nutrients_per_serving as Record<string, number>).energy_kcal).toBe(82.5);
    expect((row?.nutrients_per_serving as Record<string, number>).coverage).toBe(1);
  });
});

describe("the live strip", () => {
  it("clears the strip and shows a line when the total fails", async () => {
    const item = (await addIngredient({ items: [], notice: null },
      { source: "bundled", bundledId: CHICKEN }, deps())).items;
    const setStrip = vi.fn();
    const setError = vi.fn();

    await runLiveStrip({ items: item, servings: 1, yieldGrams: null,
      resolve: async () => { throw new Error("no cached revision"); },
      setStrip, setError });

    // The stale number is gone, not merely outvoted by an error line beside it.
    expect(setStrip).toHaveBeenCalledWith(null);
    expect(setError).toHaveBeenLastCalledWith(STRIP_FAILED_COPY);
    expect(STRIP_FAILED_COPY).toBe("Could not total this recipe. Try again.");
  });

  it("runs no total at all for an empty recipe", async () => {
    const setStrip = vi.fn();
    const setError = vi.fn();
    const resolve = vi.fn();

    await runLiveStrip({ items: [], servings: 4, yieldGrams: null, resolve, setStrip, setError });

    expect(resolve).not.toHaveBeenCalled();
    expect(setStrip).toHaveBeenCalledWith(null);
  });

  it("keeps kcal unmeasured (null) instead of showing 0 when no item measured it", async () => {
    const item = (await addIngredient({ items: [], notice: null },
      { source: "bundled", bundledId: CHICKEN }, deps())).items;
    const setStrip = vi.fn();
    const setError = vi.fn();

    // Nothing measured energy_kcal for this recipe (e.g. a cache miss with no adoption snapshot);
    // computeRecipeNutrients correctly leaves it null. The strip must not coerce that to 0 kcal,
    // which would read as a measured zero-calorie recipe next to "some nutrients unmeasured".
    await runLiveStrip({ items: item, servings: 1, yieldGrams: null,
      resolve: async () => ({ perServing: { energy_kcal: null, protein: 31 }, coverage: 0.5 }),
      setStrip, setError });

    expect(setStrip).toHaveBeenCalledWith({ kcal: null, coverage: 0.5, nutritionComplete: false });
  });
});

describe("saving a recipe", () => {
  it("clears saving and shows a notice instead of hanging on 'Saving…' when the write rejects", async () => {
    const setSaving = vi.fn();
    const setNotice = vi.fn();
    const onSaved = vi.fn();
    const input = recipeSaveInput({ items: [], name: "Rice tray", servings: 1, yieldGrams: null });

    await runSave({
      input, save: async () => { throw new Error("QuotaExceededError"); },
      setSaving, setNotice, onSaved,
    });

    // The button must come off "Saving…" even though the write failed.
    expect(setSaving).toHaveBeenCalledWith(false);
    expect(setSaving).toHaveBeenLastCalledWith(false);
    // She sees why, instead of a permanently stuck button with no feedback.
    expect(setNotice).toHaveBeenCalledWith(SAVE_FAILED_COPY);
    // The sheet must not close on a save that never happened.
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("saves and closes normally when the write succeeds", async () => {
    const setSaving = vi.fn();
    const setNotice = vi.fn();
    const onSaved = vi.fn();
    const input = recipeSaveInput({ items: [], name: "Rice tray", servings: 1, yieldGrams: null });

    await runSave({
      input, save: async () => ({ recipeId: "r1", rev: 1 }), setSaving, setNotice, onSaved,
    });

    expect(setSaving).toHaveBeenCalledWith(true);
    expect(setSaving).toHaveBeenLastCalledWith(false);
    expect(onSaved).toHaveBeenCalledWith({ recipeId: "r1", rev: 1 });
    expect(setNotice).not.toHaveBeenCalled();
  });
});
