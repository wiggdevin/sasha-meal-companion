/**
 * Every catalog row that is the same food by name — readiness pass 2026-09-18.
 *
 * Split from lib/server/catalog.ts, which is the search and detail reads. This is the one query an
 * Eats/Avoid mark needs: the active revisions whose base name is the base name of the row the coach
 * grounded their word to, and a `food_ref` for each so the mark has somewhere to land.
 *
 * Two reads, not one prefix read: a family is exactly the rows whose description IS the base name
 * or begins `<base>,`. A single `<base>%` prefix would also drag in "Watermelon juice", and on a
 * USDA catalog a word like "Chicken" or "Oil" would drag in hundreds of rows that are not one food.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { SAME_NAME_CAP, baseFoodName, sameBaseName } from "@/lib/foods/base-name";

if (typeof window !== "undefined") {
  throw new Error("lib/server/catalog-names.ts is server-only and must never reach the browser.");
}

export type NamedRevision = { catalog_food_id: number; description: string };

/** The rows that ARE this food, by base name. The database narrows; this decides. */
export function sameBaseNameFoodIds(rows: NamedRevision[], name: string): number[] {
  return [...new Set(rows.filter((row) => sameBaseName(name, row.description))
    .map((row) => row.catalog_food_id))].sort((a, b) => a - b);
}

/**
 * The base name as a LIKE pattern. `%` and `_` are wildcards and `\` is the escape character, so
 * "50% cocoa" would otherwise match half the catalog. `*` is PostgREST's own spelling of `%` and
 * cannot be escaped in a filter value, so a name carrying one is simply not widened.
 */
export function likeEscape(base: string): string | null {
  if (base.includes("*")) return null;
  return base.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Every `food_ref` their mark should reach. It mints the refs through the same RPC
 * `lib/foods/prefs-client.ts` uses, so the phone's write path and the coach's land on identical
 * rows.
 *
 * It returns the EMPTY list — the mark stays on the one row the coach grounded — whenever it
 * cannot widen honestly: an unreadable name, a failed read, a family bigger than the cap, or a ref
 * it could not mint. A partial widen is the worst answer available, because the rows it missed are
 * exactly the ones the next search will rank first.
 */
export async function sameNameRefIds(
  client: SupabaseClient, admin: SupabaseClient, userId: string, name: string,
): Promise<string[]> {
  const base = baseFoodName(name);
  const pattern = base.length === 0 ? null : likeEscape(base);
  if (pattern === null) return [];
  const read = (like: string) => client.from("catalog_food_revisions")
    .select("catalog_food_id, description")
    .eq("is_active", true)
    .ilike("description", like)
    .order("catalog_food_id", { ascending: true })
    // One more than the cap: the answer to "is this family too wide" needs no further rows.
    .limit(SAME_NAME_CAP + 1);
  const [bare, qualified] = await Promise.all([read(pattern), read(`${pattern},%`)]);
  if (bare.error || qualified.error) {
    console.error("same-name revision lookup for an avoid mark failed",
      { error: bare.error ?? qualified.error });
    return [];
  }
  const rows = [...(bare.data ?? []), ...(qualified.data ?? [])] as NamedRevision[];
  const foodIds = sameBaseNameFoodIds(rows, name);
  if (foodIds.length > SAME_NAME_CAP) return [];
  const refs = await Promise.all(foodIds.map(async (catalogFoodId) => {
    const { data, error } = await admin.rpc("get_or_create_food_ref", {
      p_user_id: userId, p_kind: "catalog",
      p_catalog_food_id: catalogFoodId, p_user_food_id: null,
    });
    if (error) console.error("minting a food_ref for a same-name mark failed", { error });
    return typeof data === "string" ? data : null;
  }));
  return refs.every((id) => id !== null) ? refs as string[] : [];
}
