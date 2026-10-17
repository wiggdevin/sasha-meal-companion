/**
 * The recipe sheet's ingredient state — T1, 2026-09-12.
 *
 * Every ingredient the user can pick funnels through ONE transition. `resolvePick` turns a pick into
 * the item it becomes or the line the user reads, with every side effect injected (`adopt`,
 * `resolveRef`, `food`), so both the bundled picker (catalog off) and the offline-tier row of the
 * catalog picker (catalog on) land here and nothing is silently dropped. `applyPick` lands the
 * outcome on the sheet state and derives `seq` from the items it is handed — the sheet applies it
 * inside a functional update, so two picks whose adoption resolves out of order both land, with
 * unique numbers. `addIngredient` is the two together, for a caller holding a snapshot.
 *
 * Pure but for the injected calls. No React, no I/O of its own.
 */
import type { CatalogRow } from "@/lib/catalog-client";
import type { DbFood } from "@/lib/food-db";
import type { NutrientCode } from "@/lib/nutrients/codes";
import type { RecipeItemInput } from "@/lib/recipes/nutrients";
import type { AdoptedBundledFood } from "@/lib/foods/adopt-client";
import type { RecipeInput } from "@/lib/recipes-client";

/** The line under the search when a pick truly cannot be added — never a silent no-op. */
export const ADD_FAILED_COPY = "Can't add this one right now";

/**
 * R6 (2026-09-13): a recipe is a meal the user plans, so it obeys the domain rule — no meal anywhere
 * contains apple, gluten or dairy. The row stays visible and marked (marking, never hiding); it is
 * the tap that is refused, with the flags named.
 */
export function offPlanCopy(flags: readonly string[]): string {
  const list = flags.length < 2 ? flags[0] ?? ""
    : flags.length === 2 ? `${flags[0]} and ${flags[1]}`
      : `${flags.slice(0, -1).join(", ")} and ${flags[flags.length - 1]}`;
  return `Not on their plan (${list})`;
}

/** Per-100 g numbers on a client-side item. The server row never carries them. */
export type ItemSnapshot = Partial<Record<NutrientCode, number | null>>;

/** A sheet item: the wire shape plus the name and snapshot the strip and the row read. */
export type RecipeDraft = RecipeItemInput & { name: string; per100g?: ItemSnapshot | null };

export type SheetState = { items: RecipeDraft[]; notice: string | null };

/**
 * One row the user tapped. `bundled` is the picker the catalog flag off renders; `offline` is the
 * fallback tier of the catalog picker; `catalog` is a live catalog row.
 */
export type IngredientPick =
  | { source: "bundled"; bundledId: string | null; offPlan?: readonly string[] }
  | { source: "offline"; bundledId: string | null; offPlan?: readonly string[] }
  | { source: "catalog"; catalogFoodId: number; revisionId: number | null; description: string;
      offPlan?: readonly string[] };

export type PickOutcome =
  | { ok: true; item: Omit<RecipeDraft, "seq"> }
  | { ok: false; notice: string };

/** Everything a pick needs from the outside. The sheet passes the real three; tests pass stubs. */
export type PickDeps = {
  adopt: (bundledId: string) => Promise<AdoptedBundledFood | null>;
  resolveRef: (catalogFoodId: number) => Promise<string | null>;
  food: (bundledId: string) => DbFood | undefined;
};

/**
 * A catalog row → the pick the transition takes. An offline row carries a bundled id, or none.
 *
 * `row.prefStatus` is their real Eats/Avoid preference — the same value CatalogSearch's `Flags()`
 * renders as an "Avoid" pill (gap-recipes-build-meal-7). A food on Avoid for a personal reason
 * (an allergic reaction, not gluten/dairy/apple) has no name-regex match and no allergen tag, so
 * `row.offPlan` can be empty even while the pill reads Avoid — folding it in here means the pill
 * is never cosmetic: the tap is refused the same way gluten/dairy/apple already are.
 */
export function pickFromCatalogRow(row: CatalogRow): IngredientPick {
  const offPlan = row.prefStatus === "avoid" && !row.offPlan.includes("avoid")
    ? [...row.offPlan, "avoid"]
    : row.offPlan;
  if (row.offline || row.catalogFoodId === null) {
    return { source: "offline", bundledId: row.offlineFoodId ?? null, offPlan };
  }
  return {
    source: "catalog", catalogFoodId: row.catalogFoodId,
    revisionId: row.revisionId ?? null, description: row.description, offPlan,
  };
}

async function resolveBundled(
  bundledId: string | null, offPlan: readonly string[] | undefined, deps: PickDeps,
): Promise<PickOutcome> {
  if (offPlan && offPlan.length > 0) return { ok: false, notice: offPlanCopy(offPlan) };
  const food = bundledId ? deps.food(bundledId) : undefined;
  // A "mine" hit from the bundled search has no bundled id (the sheet offers no own foods), so it
  // reads the same as an unknown one: the user gets the line, not a row that cannot be saved.
  if (!food) return { ok: false, notice: ADD_FAILED_COPY };
  const adopted = await deps.adopt(food.id);
  if (!adopted) return { ok: false, notice: ADD_FAILED_COPY };
  return {
    ok: true,
    item: { foodRefId: adopted.foodRefId, name: food.name, qty: 1, unit: "g", grams: 100,
      state: "cooked", foodRevisionId: null, per100g: adopted.per100g },
  };
}

/** The async half of a pick: adopt a bundled food or resolve a catalog food's ref. */
export async function resolvePick(pick: IngredientPick, deps: PickDeps): Promise<PickOutcome> {
  if (pick.source !== "catalog") return resolveBundled(pick.bundledId, pick.offPlan, deps);
  if (pick.offPlan && pick.offPlan.length > 0) {
    return { ok: false, notice: offPlanCopy(pick.offPlan) };
  }
  const foodRefId = await deps.resolveRef(pick.catalogFoodId);
  if (!foodRefId) return { ok: false, notice: ADD_FAILED_COPY };
  return {
    ok: true,
    item: { foodRefId, name: pick.description, qty: 1, unit: "g", grams: 100,
      state: "cooked", foodRevisionId: pick.revisionId },
  };
}

/** The next number for a new row, read off the items on screen, never off a stale capture. */
export function nextSeq(items: readonly { seq: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
}

/** The sync half: append the item (`seq` derived here) or set the notice. Pure. */
export function applyPick(state: SheetState, outcome: PickOutcome): SheetState {
  if (!outcome.ok) return { ...state, notice: outcome.notice };
  return { items: [...state.items, { ...outcome.item, seq: nextSeq(state.items) }], notice: null };
}

/** The whole transition for a caller holding a snapshot: resolve the pick, then land it. */
export async function addIngredient(
  state: SheetState, pick: IngredientPick, deps: PickDeps,
): Promise<SheetState> {
  return applyPick(state, await resolvePick(pick, deps));
}

/**
 * The transition as the sheet runs it: resolve off-screen, then land the outcome through the
 * caller's own updater (React's `setSheet`). `applyPick` reads the newest state inside that
 * updater, so two picks whose adoption resolves out of order both land with unique `seq` — the
 * one thing a handler holding a captured `items` array could not promise.
 */
export async function addIngredientInto(
  update: (apply: (prev: SheetState) => SheetState) => void,
  pick: IngredientPick, deps: PickDeps,
): Promise<void> {
  const outcome = await resolvePick(pick, deps);
  update((prev) => applyPick(prev, outcome));
}

/** The Save button's own rule, so a test can assert the value the button is disabled by.
 *  A recipe needs a name: a blank one saved a row that rendered as an empty card on Foods and an
 *  empty row under "Other foods" (2026-09-22). */
export function canSave(items: readonly RecipeDraft[], saving: boolean, name: string): boolean {
  return !saving && items.length > 0 && name.trim().length > 0;
}

/** What Save hands `saveRecipe`. One place builds it, so the items that reach the client are the
 *  items on screen. */
export function recipeSaveInput(args: {
  items: RecipeDraft[]; name: string; servings: number; yieldGrams: number | null;
  id?: string; baseRev?: number;
}): RecipeInput {
  return {
    // Trimmed here so the stored name is the displayed name — canSave already refuses a blank.
    id: args.id, baseRev: args.baseRev, name: args.name.trim(), servings: args.servings,
    yieldGrams: args.yieldGrams, items: args.items,
  };
}
