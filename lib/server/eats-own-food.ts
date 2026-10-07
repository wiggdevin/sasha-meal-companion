import type { SupabaseClient } from "@supabase/supabase-js";
import type { FoodHit } from "@/lib/coach/executors";
import { getFoodDetail, type FoodSearchHit } from "@/lib/server/catalog";
import { mapCatalogFoodHit } from "@/lib/server/coach";
import { foodNamesFor } from "@/lib/server/day-context";
import { fetchAllRows } from "@/lib/server/paged-read";

type CatalogRef = { refId: string; catalogFoodId: number };
const norm = (name: string) => name.trim().toLocaleLowerCase().replace(/\s+/g, " ");

/**
 * An Eats food by its exact name, without a catalog search (2026-10-02). A search cost ~27
 * database requests — the full-text RPC, then a food ref and a six-read detail per hit — and a
 * suggestion build made ~100 of them; under a busy database the RPC averaged 1.5 s and no card
 * was ready in 5 s. The account's own food comes from `exactUserFood`; a catalog food on their
 * Eats list is resolved through the ref they already hold and read with one detail. Anything else
 * is null, and the caller searches as before.
 */
export function eatsOwnFood(client: SupabaseClient,
  exactUserFood: (userId: string, name: string, signal?: AbortSignal) => Promise<FoodHit | null>) {
  // Per account, and a failed read is not kept (Grok audit round 9): the next call reads again.
  const refs = new Map<string, Promise<Map<string, CatalogRef>>>();
  const catalogRefs = (userId: string) => {
    const known = refs.get(userId);
    if (known) return known;
    const read = readCatalogRefs(userId);
    refs.set(userId, read);
    read.catch(() => refs.delete(userId));
    return read;
  };
  const readCatalogRefs = async (userId: string) => {
    const prefs = await fetchAllRows<{ food_ref_id: string }>((from, to) => client.from("user_food_prefs")
      .select("food_ref_id").eq("user_id", userId).eq("status", "eats").order("food_ref_id").range(from, to));
    const ids = [...new Set(prefs.map((row) => row.food_ref_id))];
    if (ids.length === 0) return new Map<string, CatalogRef>();
    const rows = await client.from("food_refs").select("id, catalog_food_id").in("id", ids).eq("kind", "catalog");
    if (rows.error) throw rows.error;
    const catalog = ((rows.data ?? []) as { id: string; catalog_food_id: number | null }[])
      .filter((row): row is { id: string; catalog_food_id: number } => row.catalog_food_id !== null);
    const names = await foodNamesFor(client, catalog.map((row) => row.id));
    const byName = new Map<string, CatalogRef>();
    for (const row of catalog) {
      const name = names.get(row.id);
      if (name && !byName.has(norm(name))) byName.set(norm(name), { refId: row.id, catalogFoodId: row.catalog_food_id });
    }
    return byName;
  };
  return async (userId: string, name: string, signal?: AbortSignal): Promise<FoodHit | null> => {
    const own = await exactUserFood(userId, name, signal);
    if (own) return own;
    signal?.throwIfAborted();
    const ref = (await catalogRefs(userId).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return new Map<string, CatalogRef>();
    })).get(norm(name));
    if (!ref) return null;
    signal?.throwIfAborted();
    const detail = await getFoodDetail(client, ref.catalogFoodId).catch(() => null);
    // `mapCatalogFoodHit`'s `hit` argument only reads description/brand/source/policy/prefStatus,
    // every one of them shared with `detail` unchanged — `detail` doubling as the hit here predates
    // this file. The cast is needed only because FoodDetail's own `per100g`/`portions` (read from
    // the SECOND argument, never the first) now carry a different shape from the UI lane's
    // simplified `FoodSearchHit.per100g`/`portions` (lib/foods/portions.ts), which `hit` never uses.
    return detail ? mapCatalogFoodHit(detail as unknown as FoodSearchHit, detail, ref.refId) : null;
  };
}
