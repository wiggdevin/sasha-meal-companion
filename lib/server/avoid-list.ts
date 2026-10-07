import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllChunked, fetchAllRows } from "@/lib/server/paged-read";

type Ref = { id: string; kind: "catalog" | "user"; catalog_food_id: number | null;
  user_food_id: string | null };

/** The account's Avoid list: every avoided food ref, and the names those refs carry. */
export type AvoidList = { refIds: string[]; names: string[] };

/**
 * The account's complete Avoid list, paged past the API row cap (t18, 2026-10-05). Shared by the
 * recipe policy (lib/server/recipe-candidates.ts) and shopping rule marks
 * (lib/server/shopping-rule-marks.ts), so both judge against the same list.
 *
 * Any failed page or chunk rejects: a partial list must never read as "no Avoid rules". The ref
 * ids come from this account's own prefs; its own foods are also filtered by owner. `food_refs`
 * and `catalog_food_revisions` carry no owner column (a catalog ref is shared). Every paged query
 * is ordered by its primary key, so offset paging neither skips nor repeats a row.
 */
export async function readAvoidList(client: SupabaseClient, userId: string): Promise<AvoidList> {
  const prefs = await fetchAllRows<{ food_ref_id: string }>((from, to) =>
    client.from("user_food_prefs").select("food_ref_id")
      .eq("user_id", userId).eq("status", "avoid").order("food_ref_id")
      .range(from, to));
  const refIds = [...new Set(prefs.map((row) => String(row.food_ref_id)))];
  const refs = await fetchAllChunked<string, Ref>(refIds, (ids, from, to) =>
    client.from("food_refs").select("id,kind,catalog_food_id,user_food_id")
      .in("id", ids).order("id").range(from, to));
  const userFoodIds = refs.filter((ref) => ref.kind === "user" && ref.user_food_id)
    .map((ref) => ref.user_food_id as string);
  const catalogIds = refs.filter((ref) => ref.kind === "catalog" && ref.catalog_food_id)
    .map((ref) => ref.catalog_food_id as number);
  const [mine, catalog] = await Promise.all([
    fetchAllChunked<string, { name: string }>(userFoodIds, (ids, from, to) =>
      client.from("user_foods").select("name")
        .eq("user_id", userId).in("id", ids).order("id").range(from, to)),
    fetchAllChunked<number, { description: string }>(catalogIds, (ids, from, to) =>
      client.from("catalog_food_revisions").select("description")
        .in("catalog_food_id", ids).eq("is_active", true).order("id").range(from, to)),
  ]);
  const names = [...new Set([...mine.map((row) => row.name),
    ...catalog.map((row) => row.description)])];
  return { refIds, names };
}
