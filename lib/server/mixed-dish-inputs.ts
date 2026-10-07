/**
 * The W3 mixed-dish hook's data (Phase 18 W4, D5): a logged FNDDS dish's documented recipe
 * inputs from `catalog_food_inputs`, as RAW identifiers and grams per gram of dish. Every input is
 * then resolved and judged by lib/server/taste-history.ts through the same boundary as any other
 * row (lib/server/taste-resolve.ts); nothing here decides what counts.
 *
 * - Sub-recipes: an input that is itself an FNDDS food with inputs is expanded, to MAX_DEPTH
 *   levels, never through a cycle; each leaf's share multiplies down the path.
 * - Shares: an input's grams over its dish's total grams (cooking yield ignored, as in the W1b
 *   crosswalk). The same leaf reached twice adds up.
 * - Identifier of a leaf: its catalog food ref when one exists (judged on that ref's evidence);
 *   else, for an SR Legacy food that is a universe item, that item's bundled id (judged by the W2b
 *   `universeVerdict`); else its catalog food id, which the resolver cannot vouch for without a
 *   ref, so it adds nothing (fail-closed).
 * - Not a mixed dish: a food whose inputs reach fewer than two distinct leaf foods ("Banana, raw"
 *   is one SR banana). It is left out of the map and counts as itself.
 *
 * Tenancy: only shared catalog rows (`catalog_food_revisions`, `catalog_food_inputs`,
 * `catalog_foods`, catalog `food_refs`), read on the caller's own client by the ids its own history
 * names, through `readByIdBatches` so the row cap never truncates. A failed read rejects the whole
 * taste read; it never returns part of a dish.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { universeBySrCode } from "@/lib/meals/taste-identity";
import { readByIdBatches } from "@/lib/server/date-chunks";
import type { MixedDishInput } from "@/lib/server/taste-history";

export const MAX_DEPTH = 4;
export const MIN_MIXED_LEAVES = 2;

type Input = { food: number; grams: number };
type Food = { source: string; source_id: string };

async function select<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error instanceof Error ? error : new Error(String((error as { message?: unknown }).message));
  return (data ?? []) as T[];
}

/** Loads the inputs of `ids` and of every FNDDS sub-recipe under them, MAX_DEPTH levels deep. */
async function loadTree(client: SupabaseClient, dishIds: readonly number[]) {
  const inputsOf = new Map<number, Input[]>();
  const foods = new Map<number, Food>();
  let pending = [...new Set(dishIds)];
  for (let depth = 0; depth <= MAX_DEPTH && pending.length; depth += 1) {
    for (const id of pending) inputsOf.set(id, []);
    const revisions = await readByIdBatches(pending, (batch) => select<{ id: number; catalog_food_id: number }>(
      client.from("catalog_food_revisions").select("id,catalog_food_id").eq("is_active", true).in("catalog_food_id", batch)));
    const dishOf = new Map(revisions.map((row) => [Number(row.id), Number(row.catalog_food_id)]));
    const rows = await readByIdBatches([...dishOf.keys()], (batch) => select<{ food_revision_id: number; seq: number;
      input_catalog_food_id: number; grams: unknown }>(client.from("catalog_food_inputs")
      .select("food_revision_id,seq,input_catalog_food_id,grams").in("food_revision_id", batch)));
    for (const row of [...rows].sort((a, b) => Number(a.food_revision_id) - Number(b.food_revision_id) || a.seq - b.seq)) {
      const grams = Number(row.grams);
      const dish = dishOf.get(Number(row.food_revision_id));
      if (dish === undefined || !(grams > 0)) continue;
      inputsOf.get(dish)!.push({ food: Number(row.input_catalog_food_id), grams });
    }
    const unseen = [...new Set(rows.map((row) => Number(row.input_catalog_food_id)))].filter((id) => !foods.has(id));
    for (const row of await readByIdBatches(unseen, (batch) => select<{ id: number } & Food>(client
      .from("catalog_foods").select("id,source,source_id").in("id", batch)))) foods.set(Number(row.id), row);
    pending = unseen.filter((id) => foods.get(id)?.source === "fdc_fndds" && !inputsOf.has(id));
  }
  return { inputsOf, foods };
}

/** Leaf food → share of one gram of `dish`. */
function leavesOf(dish: number, inputsOf: ReadonlyMap<number, Input[]>): Map<number, number> {
  const out = new Map<number, number>();
  const walk = (food: number, share: number, path: ReadonlySet<number>, depth: number) => {
    const inputs = inputsOf.get(food);
    const total = inputs?.reduce((sum, input) => sum + input.grams, 0) ?? 0;
    if (!inputs?.length || total <= 0 || path.has(food) || depth > MAX_DEPTH) {
      out.set(food, (out.get(food) ?? 0) + share);
      return;
    }
    const next = new Set(path).add(food);
    for (const input of inputs) walk(input.food, share * (input.grams / total), next, depth + 1);
  };
  const inputs = inputsOf.get(dish);
  if (!inputs?.length) return out;
  walk(dish, 1, new Set(), 0);
  return out;
}

/** The W3 `MixedDishInputs` port over the catalog (lib/server/taste-admission.ts DEFAULT_TASTE_PORTS). */
export async function readMixedDishInputs(catalogFoodIds: number[], client: SupabaseClient):
  Promise<Map<number, MixedDishInput[]>> {
  const out = new Map<number, MixedDishInput[]>();
  if (!catalogFoodIds.length) return out;
  const { inputsOf, foods } = await loadTree(client, catalogFoodIds);
  const leaves = new Map(catalogFoodIds.map((dish) => [dish, leavesOf(dish, inputsOf)]));
  const mixed = [...leaves].filter(([, shares]) => shares.size >= MIN_MIXED_LEAVES);
  const leafIds = [...new Set(mixed.flatMap(([, shares]) => [...shares.keys()]))];
  const refOf = new Map((await readByIdBatches(leafIds, (batch) => select<{ id: string; catalog_food_id: number }>(
    client.from("food_refs").select("id,catalog_food_id").eq("kind", "catalog").in("catalog_food_id", batch))))
    .map((row) => [Number(row.catalog_food_id), row.id]));
  for (const [dish, shares] of mixed) {
    out.set(dish, [...shares].sort(([a], [b]) => a - b).map(([leaf, gramsPerGram]): MixedDishInput => {
      const ref = refOf.get(leaf);
      if (ref) return { foodRefId: ref, gramsPerGram };
      const food = foods.get(leaf);
      const universe = food?.source === "fdc_sr_legacy" && /^\d+$/.test(food.source_id)
        ? universeBySrCode(Number(food.source_id)) : null;
      return universe ? { foodDbId: universe.key.slice(2), gramsPerGram } : { catalogFoodId: leaf, gramsPerGram };
    }));
  }
  return out;
}
