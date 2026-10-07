"use client";

/**
 * The recipe sheet's state and handlers — T1, 2026-09-12. Everything the view needs, minus the
 * markup, so RecipeSheet.tsx stays a view and both picker tiers run the one transition in
 * lib/recipes/recipe-sheet-state.ts. Two effects: the mount seed fills a reopened item's name and
 * snapshot from the catalog cache or the adopted-food index, and the strip recomputes whenever the
 * items, servings or yield move.
 */
import { currentAccountOrNull } from "@/lib/device/account";
import { useEffect, useMemo, useState } from "react";
import { catalogSearchEnabled, type CatalogRow } from "@/lib/catalog-client";
import { getRevision } from "@/lib/db/catalog-cache";
import { dbFood } from "@/lib/food-db";
import { adoptedSnapshot, adoptBundledFood,
  type AdoptedSnapshot } from "@/lib/foods/adopt-client";
import { resolveFoodRef } from "@/lib/log-client";
import { isNutritionComplete, recipeInputGrams } from "@/lib/recipes/nutrients";
import { browserClient } from "@/lib/supabase/client";
import { withAccount } from "@/lib/device/account-supabase";
import {
  addIngredientInto, canSave, pickFromCatalogRow, recipeSaveInput,
  type IngredientPick, type PickDeps, type RecipeDraft, type SheetState,
} from "@/lib/recipes/recipe-sheet-state";
import { provisionalNutrients, saveRecipe, type RecipeInput, type RecipeRow } from "@/lib/recipes-client";

/** The real three a pick injects. Tests drive the transition with their own. */
export const PICK_DEPS: PickDeps = {
  adopt: adoptBundledFood, resolveRef: resolveFoodRef, food: dbFood,
};

/** Shown until the seed effect finds the real name — never written back to the server. */
const PLACEHOLDER_NAME = "Saved food";

/** The inline line under the picker when the recipe could not be totalled. Never a stale number. */
export const STRIP_FAILED_COPY = "Could not total this recipe. Try again.";

/** A saved recipe's wire item → a sheet draft. Name and snapshot come from the seed effect. */
export function draftFromWire(item: Record<string, unknown>): RecipeDraft {
  return {
    seq: Number(item.seq), foodRefId: String(item.food_ref_id), qty: Number(item.qty),
    unit: String(item.unit), grams: Number(item.grams), state: item.state as "raw" | "cooked",
    foodRevisionId: item.food_revision_id == null ? null : Number(item.food_revision_id),
    name: PLACEHOLDER_NAME, per100g: null,
  };
}

/**
 * The slow half of the seed: an adopted bundled food whose row is not in this device's local
 * index — a fresh install, or a phone that signed in after the food was adopted elsewhere. The
 * server row is the real store, so read it through the owner-scoped registry: `food_refs` gives
 * the user_food_id, and `user_foods` gives the name and the per-100 g numbers. Injectable so a
 * test can drive the seed with a stubbed row read.
 */
export type ReadAdopted = (foodRefId: string) => Promise<AdoptedSnapshot | undefined>;

export async function readAdoptedBundledFood(
  foodRefId: string,
): Promise<AdoptedSnapshot | undefined> {
  // Phase 9 §0.5a: read for the bound account, and drop an answer that lands after a switch.
  const h = currentAccountOrNull();
  if (h === null) return undefined;
  try {
    const supabase = browserClient();
    const ref = await withAccount(h, () => supabase.from("food_refs").select("user_food_id")
      .eq("id", foodRefId).single());
    const userFoodId = (ref.data as { user_food_id?: unknown } | null)?.user_food_id;
    if (ref.error || typeof userFoodId !== "string") return undefined;
    const food = await withAccount(h, () => supabase.from("user_foods")
      .select("name, per_100g").eq("id", userFoodId).single());
    const row = food.data as { name?: unknown; per_100g?: unknown } | null;
    if (food.error || !row || typeof row.name !== "string") return undefined;
    // The stored map is `{nutrient_code: amount|null}`, the shape compute_item_snapshot reads;
    // codes the bundled mapping never wrote are harmless on a client-side item snapshot.
    return { name: row.name, per100g: (row.per_100g ?? {}) as AdoptedSnapshot["per100g"] };
  } catch {
    // Signed out, offline, or no browser client configured — the placeholder is the fallback.
    return undefined;
  }
}

/**
 * A draft's name and numbers, from the cached revision, then from what adoption remembered on
 * this device, then from the server row. The local index stays the fast path: no I/O when it hits.
 */
export async function seededDraft(
  draft: RecipeDraft, readAdopted: ReadAdopted = readAdoptedBundledFood,
): Promise<RecipeDraft> {
  if (draft.foodRevisionId != null) {
    const cached = await getRevision(draft.foodRevisionId);
    return cached ? { ...draft, name: cached.description } : draft;
  }
  const adopted = await adoptedSnapshot(draft.foodRefId);
  if (adopted) return { ...draft, name: adopted.name, per100g: adopted.per100g };
  const remote = await readAdopted(draft.foodRefId);
  return remote ? { ...draft, name: remote.name, per100g: remote.per100g } : draft;
}

/** Runs once, on the recipe the sheet opened with. Later changes go through the handlers below. */
function useSeededNames(
  seed: RecipeDraft[], setSheet: (update: (prev: SheetState) => SheetState) => void,
  readAdopted: ReadAdopted = readAdoptedBundledFood,
): void {
  useEffect(() => {
    if (seed.length === 0) return;
    let live = true;
    void (async () => {
      const named = await Promise.all(seed.map((draft) => seededDraft(draft, readAdopted)));
      if (!live) return;
      const byRef = new Map(named.map((draft) => [draft.foodRefId, draft]));
      // Merge onto the CURRENT items: a pick that landed while these lookups were in flight keeps
      // its row, and only the placeholder name is replaced.
      setSheet((prev) => ({ ...prev, items: prev.items.map((item) => {
        const seeded = byRef.get(item.foodRefId);
        if (!seeded || item.name !== PLACEHOLDER_NAME) return item;
        return { ...item, name: seeded.name, per100g: seeded.per100g ?? item.per100g };
      }) }));
    })();
    return () => { live = false; };
    // Seed once on mount from the recipe passed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Shown in the sheet's own notice line when a save write rejects. Never a stuck "Saving…" button. */
export const SAVE_FAILED_COPY = "Could not save this recipe. Try again.";

/**
 * The save button's one step, pulled out of the handler so a test can drive the failure branch
 * with a save that rejects — the same shape as `runLiveStrip` above, for the same reason (no React
 * rendering harness exists, contracts §1). Production passes `saveRecipe` and this hook's setters.
 */
export async function runSave(args: {
  input: RecipeInput;
  save: (input: RecipeInput) => Promise<{ recipeId: string; rev: number }>;
  setSaving: (saving: boolean) => void; setNotice: (notice: string | null) => void;
  onSaved: (result: { recipeId: string; rev: number }) => void;
}): Promise<void> {
  args.setSaving(true);
  try {
    const result = await args.save(args.input);
    args.onSaved(result);
  } catch {
    // A failed write must not leave the button stuck on "Saving…" with no way to retry.
    args.setNotice(SAVE_FAILED_COPY);
  } finally {
    args.setSaving(false);
  }
}

/**
 * The live per-serving strip. `nutritionComplete: false` means `kcal` sums only the measured
 * ingredients — a partial count the view must label as such, never "N kcal a serving" (#21).
 */
export type RecipeStrip = { kcal: number | null; coverage: number; nutritionComplete: boolean };
type Strip = RecipeStrip | null;
type NutrientResolver = (items: RecipeDraft[], servings: number, yieldGrams: number | null) =>
  Promise<{ perServing: Record<string, number | null>; coverage: number }>;

/**
 * The strip's one step, pulled out of the effect so a test can drive the failure branch with a
 * resolver that rejects — no React rendering harness exists (contracts §1). Production passes
 * `provisionalNutrients` and this hook's own setters.
 */
export async function runLiveStrip(args: {
  items: RecipeDraft[]; servings: number; yieldGrams: number | null;
  resolve: NutrientResolver;
  setStrip: (strip: Strip) => void; setError: (message: string | null) => void;
  isLive?: () => boolean;
}): Promise<void> {
  // An empty recipe has nothing to total: no strip at all, not "0 kcal" on a new sheet.
  if (args.items.length === 0) {
    args.setStrip(null);
    args.setError(null);
    return;
  }
  const live = args.isLive ?? (() => true);
  args.setError(null);
  try {
    const { perServing, coverage } =
      await args.resolve(args.items, args.servings, args.yieldGrams);
    // `energy_kcal` is null when nothing in the recipe measured it (computeRecipeNutrients) — an
    // unmeasured total, not a measured zero. Coercing it to 0 would read as a fact next to the
    // "some nutrients unmeasured" caveat, so it stays null and the view shows no number instead.
    const kcal = perServing.energy_kcal == null ? null : Math.round(perServing.energy_kcal);
    if (live()) args.setStrip({ kcal, coverage, nutritionComplete: isNutritionComplete(coverage) });
  } catch {
    // A failed total must not leave the last number standing — clear it and say so.
    if (live()) {
      args.setStrip(null);
      args.setError(STRIP_FAILED_COPY);
    }
  }
}

/** The live strip: the numbers the server is about to store, before it has stored them. */
function useLiveStrip(
  items: RecipeDraft[], servings: number, yieldGrams: number | null,
  setStrip: (strip: Strip) => void, setError: (message: string | null) => void,
): void {
  useEffect(() => {
    let live = true;
    void runLiveStrip({ items, servings, yieldGrams, resolve: provisionalNutrients,
      setStrip, setError, isLive: () => live });
    return () => { live = false; };
  }, [items, servings, yieldGrams, setStrip, setError]);
}

export type RecipeSheetModel = {
  name: string; setName: (name: string) => void;
  servings: number; setServings: (servings: number) => void;
  yieldGrams: number | null; setYieldGrams: (grams: number | null) => void;
  items: RecipeDraft[]; totalGrams: number; notice: string | null;
  strip: Strip;
  stripError: string | null;
  saving: boolean; canSave: boolean; query: string; setQuery: (query: string) => void;
  useCatalog: boolean;
  pickBundled: (bundledId: string) => void; pickCatalog: (row: CatalogRow) => void;
  setGrams: (index: number, grams: number) => void; remove: (index: number) => void;
  save: () => Promise<void>;
};

type SheetFields = {
  name: string; setName: (name: string) => void;
  servings: number; setServings: (servings: number) => void;
  yieldGrams: number | null; setYieldGrams: (grams: number | null) => void;
  sheet: SheetState; setSheet: (update: (prev: SheetState) => SheetState) => void;
  strip: Strip; totalGrams: number;
  stripError: string | null;
  saving: boolean; setSaving: (saving: boolean) => void;
  query: string; setQuery: (query: string) => void;
};

/** The fields the user edits, the items, and the two effects that keep them true. */
function useSheetFields(recipe?: RecipeRow): SheetFields {
  const [name, setName] = useState(recipe?.name ?? "");
  const [servings, setServings] = useState(recipe?.servings ?? 4);
  const [yieldGrams, setYieldGrams] = useState<number | null>(recipe?.yield_grams ?? null);
  const [sheet, setSheet] = useState<SheetState>(
    () => ({ items: (recipe?.items ?? []).map(draftFromWire), notice: null }));
  const [strip, setStrip] = useState<Strip>(null);
  const [stripError, setStripError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  useSeededNames((recipe?.items ?? []).map(draftFromWire), setSheet);
  useLiveStrip(sheet.items, servings, yieldGrams, setStrip, setStripError);
  const totalGrams = useMemo(() => recipeInputGrams(sheet.items), [sheet.items]);

  return { name, setName, servings, setServings, yieldGrams, setYieldGrams, sheet, setSheet,
    strip, stripError, totalGrams, saving, setSaving, query, setQuery };
}

type SheetActions = Pick<RecipeSheetModel, "setGrams" | "remove" | "save" | "pickBundled"
  | "pickCatalog">;

/** The handlers, over the fields above. `pick` is the one both picker tiers arrive at. */
function useSheetActions(fields: SheetFields, recipe: RecipeRow | undefined,
  onSaved: (result: { recipeId: string; rev: number }) => void): SheetActions {
  const { sheet, setSheet, saving, setSaving, name, servings, yieldGrams } = fields;

  /** One handler for both picker tiers — the flag-off bundled list and the flag-on offline row
   *  both arrive here, and land through the functional update addIngredientInto takes. */
  async function pick(choice: IngredientPick): Promise<void> {
    setSheet((prev) => ({ ...prev, notice: null }));
    await addIngredientInto(setSheet, choice, PICK_DEPS);
  }

  function setGrams(index: number, grams: number): void {
    setSheet((prev) => ({ ...prev,
      items: prev.items.map((item, i) => (i === index ? { ...item, grams } : item)) }));
  }

  function remove(index: number): void {
    setSheet((prev) => ({ ...prev,
      items: prev.items.filter((_, i) => i !== index).map((item, i) => ({ ...item, seq: i + 1 })) }));
  }

  async function save(): Promise<void> {
    // The button is disabled on the same rule; this guards every other caller (Enter, a submit).
    if (!canSave(sheet.items, saving, name)) return;
    const input = recipeSaveInput({ items: sheet.items, name, servings,
      yieldGrams, id: recipe?.id, baseRev: recipe?.rev });
    await runSave({
      input, save: saveRecipe, setSaving, onSaved,
      setNotice: (notice) => setSheet((prev) => ({ ...prev, notice })),
    });
  }

  return {
    setGrams, remove, save,
    pickBundled: (bundledId) => void pick({ source: "bundled", bundledId }),
    pickCatalog: (row) => void pick(pickFromCatalogRow(row)),
  };
}

export function useRecipeSheet({ recipe, onSaved }: {
  recipe?: RecipeRow; onSaved: (result: { recipeId: string; rev: number }) => void;
}): RecipeSheetModel {
  const fields = useSheetFields(recipe);
  const actions = useSheetActions(fields, recipe, onSaved);

  return {
    name: fields.name, setName: fields.setName,
    servings: fields.servings, setServings: fields.setServings,
    yieldGrams: fields.yieldGrams, setYieldGrams: fields.setYieldGrams,
    items: fields.sheet.items, totalGrams: fields.totalGrams, notice: fields.sheet.notice,
    strip: fields.strip, stripError: fields.stripError, saving: fields.saving,
    canSave: canSave(fields.sheet.items, fields.saving, fields.name),
    query: fields.query, setQuery: fields.setQuery,
    useCatalog: catalogSearchEnabled(),
    ...actions,
  };
}
