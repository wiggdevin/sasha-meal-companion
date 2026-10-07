/**
 * The client half of the recipes entity — Phase 3 spec, "Client changes".
 *
 * Local first: the row lands in IndexedDB and the op goes to the outbox, so a recipe saved on the
 * train is theirs the moment the user taps Save. The nutrients shown until the op lands are provisional,
 * computed from the cached catalog rows with lib/recipes/nutrients.ts; the server recomputes them
 * in SQL from compute_item_snapshot and its value wins on the next pull (architecture §3.3).
 */
import { accountHandle, type AccountHandle } from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import { getRevision } from "@/lib/db/catalog-cache";
import { computeRecipeNutrients, recipeNutritionStatus, type Per100gByRef, type RecipeItemInput,
  type RecipeNutrition } from "@/lib/recipes/nutrients";
import type { NutrientCode } from "@/lib/nutrients/codes";
import { allRows, getRow, putRow } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";
import { browserClient } from "@/lib/supabase/client";

export type RecipeInput = {
  id?: string; name: string; servings: number; yieldGrams?: number | null;
  items: RecipeItemInput[]; baseRev?: number;
};

export type RecipeRow = {
  id: string; name: string; servings: number; yield_grams: number | null; rev: number;
  items: Record<string, unknown>[]; nutrients_per_serving: Record<string, number | null>;
  deleted_at?: string | null; food_ref_id?: string;
};

function wireItems(items: RecipeItemInput[]): Record<string, unknown>[] {
  return items.map((item) => ({ seq: item.seq, food_ref_id: item.foodRefId, qty: item.qty,
    unit: item.unit, grams: item.grams, state: item.state,
    food_revision_id: item.foodRevisionId ?? null }));
}

export async function provisionalNutrients(
  items: RecipeItemInput[], servings: number, yieldGrams?: number | null,
  h: AccountHandle = accountHandle(),
): Promise<RecipeNutrition> {
  const per100g: Per100gByRef = {};
  for (const item of items) {
    // An item carrying its own snapshot (an adopted bundled food, whose food ref has no revision
    // yet) reads from that first; otherwise the cached revision. Neither present contributes an
    // empty map, so it counts against coverage rather than silently reading as measured.
    const cached = item.foodRevisionId == null ? undefined : await getRevision(item.foodRevisionId, h);
    per100g[item.foodRefId] = (item.per100g ?? cached?.per_100g ?? {}) as
      Record<NutrientCode, number | null>;
  }
  return computeRecipeNutrients(items, per100g, servings, yieldGrams ?? undefined);
}

/**
 * What a recipe card may claim about one serving (#21): the kcal, and whether that kcal is the
 * whole serving. `nutritionComplete: false` means some ingredient is unmeasured and `kcal` is a
 * partial count — the UI must say so ("at least N kcal", "partial") rather than "N kcal a serving".
 */
export function recipeServingNutrition(row: Pick<RecipeRow, "nutrients_per_serving">):
  { kcal: number | null; coverage: number; nutritionComplete: boolean } {
  const stored = row.nutrients_per_serving ?? {};
  const raw = stored.energy_kcal;
  const kcal = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  return { kcal, ...recipeNutritionStatus(stored) };
}

/**
 * The food refs this account logs its partly measured recipes through (#21), from rows already on
 * the phone: a recipe row carries its loggable twin's `food_ref_id` and its stored coverage. Lets
 * a card pulled from the server be marked partial without any new column. Judged by the row's
 * current revision (log items keep no recipe revision).
 */
export function partialRecipeRefIds(rows: readonly Partial<RecipeRow>[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    // A deleted recipe's earlier servings are still partial counts: deleted rows count too.
    if (typeof row.food_ref_id !== "string") continue;
    if (!recipeNutritionStatus(row.nutrients_per_serving).nutritionComplete) out.add(row.food_ref_id);
  }
  return out;
}

/** The same set read from this account's IDB mirror; null when it could not be read. */
export async function loadPartialRecipeRefIds(h: AccountHandle = accountHandle()): Promise<Set<string> | null> {
  try {
    return partialRecipeRefIds((await allRows(h, "recipes")) as unknown as Partial<RecipeRow>[]);
  } catch {
    return null;
  }
}

export async function saveRecipe(input: RecipeInput): Promise<{ recipeId: string; rev: number }> {
  const h = accountHandle();
  const recipeId = input.id ?? crypto.randomUUID();
  const rev = (input.baseRev ?? 0) + 1;
  const payload = {
    id: recipeId, name: input.name, servings: input.servings,
    yield_grams: input.yieldGrams ?? null, items: wireItems(input.items),
  };
  const { perServing, coverage } = await provisionalNutrients(
    input.items, input.servings, input.yieldGrams, h);
  const existing = (await getRow(h, "recipes", recipeId)) as RecipeRow | undefined;
  await putRow(h, "recipes", recipeId, {
    ...existing, ...payload, rev, deleted_at: null,
    nutrients_per_serving: { ...perServing, coverage },
    updated_at: new Date().toISOString(),
  });
  await enqueue(h, {
    op_id: crypto.randomUUID(), entity: "recipes", entity_id: recipeId,
    kind: input.baseRev === undefined ? "create" : "update",
    base_rev: input.baseRev ?? null, payload, client_ts: new Date().toISOString(),
  });
  return { recipeId, rev };
}

export async function listRecipes(): Promise<RecipeRow[]> {
  const h = accountHandle();
  const rows = (await allRows(h, "recipes")) as unknown as RecipeRow[];
  return rows.filter((row) => !row.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Soft-delete an account recipe. Logged servings keep their original snapshots. */
export async function deleteRecipe(recipe: RecipeRow): Promise<void> {
  const h = accountHandle();
  const existing = (await getRow(h, "recipes", recipe.id)) as RecipeRow | undefined;
  if (!existing || existing.deleted_at) throw new Error("This recipe has already been removed.");
  if (existing.rev !== recipe.rev) throw new Error("This recipe changed. Reopen it before removing.");
  const at = new Date().toISOString();
  await putRow(h, "recipes", recipe.id, { ...existing, deleted_at: at, rev: existing.rev + 1 });
  await enqueue(h, {
    op_id: crypto.randomUUID(), entity: "recipes", entity_id: recipe.id,
    kind: "delete", base_rev: existing.rev, payload: {}, client_ts: at,
  });
}

/**
 * The registry row their recipe logs through. It is minted server-side by _sync_upsert, but that
 * enriched `current` only reaches this device on a later pullChanges() (applyApplied's own
 * 'applied' branch merges op.payload, which never carries food_ref_id) — so the local mirror can
 * lag well behind a save that has already landed. When the mirror has not caught up yet, ask the
 * server directly with the same get_or_create_food_ref RPC lib/log-client.ts's resolveFoodRef uses
 * for a catalog food: it is a genuine get-or-create, so it only ever returns the row
 * _sync_upsert already minted for this recipe, never creates a second one. That still answers
 * null for a recipe that has never synced (the RPC's ownership check has no user_foods row to
 * find), which is the one case with no server answer to give.
 */
export async function recipeFoodRefId(recipeId: string): Promise<string | null> {
  const h = accountHandle();
  const row = (await getRow(h, "recipes", recipeId)) as RecipeRow | undefined;
  if (typeof row?.food_ref_id === "string") return row.food_ref_id;
  try {
    const supabase = browserClient();
    const { data, error } = await withAccount(h, (owner) => supabase.rpc("get_or_create_food_ref", {
      p_user_id: owner, p_kind: "user", p_catalog_food_id: null, p_user_food_id: recipeId,
    }));
    return error || typeof data !== "string" ? null : data;
  } catch {
    return null;
  }
}
