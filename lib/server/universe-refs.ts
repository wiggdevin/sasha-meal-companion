/**
 * Food refs for open-world universe foods (Phase 18 W8/W9/W10 follow-up, "a `universe:<id>`
 * foodRefId is not committable"). A generated plate row from the open pool carries the pool id
 * `universe:<bundled id>`, which is not a `food_refs.id`, so "Log it" answered 422 and "Save as
 * recipe" was refused. Every universe item is a bundled SR Legacy row with an `fdcId`, and the
 * catalog holds that row as `catalog_foods (source 'fdc_sr_legacy', source_id = fdcId)`, so this
 * mints the account's ordinary catalog ref for it, the same `get_or_create_food_ref` call coach
 * food search makes for every hit (lib/server/coach-ports.ts `searchFoods`). No migration.
 *
 * It resolves identity only: admission already happened (the ids come from an admitted pool) and
 * the log commit still judges every item under the account's current rules. A row it cannot
 * resolve (no bundled row, no catalog food, no active revision, a failed read) is left out; the
 * caller never puts a non-ref id on an action. The active revision is returned so the logged
 * snapshot is pinned to the revision the card's numbers came from (a later re-import answers
 * `stale_revision`, never a silent move).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbFood } from "@/lib/food-db";
import { universeIdOf } from "@/lib/foods/universe/food";

export type UniverseRef = { foodRefId: string; catalogFoodRevisionId: number };

/** At most this many refs per call: a suggestion run ranks up to 12 plates of a few rows each. */
export const UNIVERSE_REF_LIMIT = 60;

/**
 * `{ [universe pool id]: ref }` for the pool ids that are universe items and resolve. Non-universe
 * ids are ignored. Never throws: a failed read resolves nothing.
 */
export async function universeFoodRefs(admin: SupabaseClient, userId: string,
  poolIds: readonly string[]): Promise<Record<string, UniverseRef>> {
  const bySource = new Map<string, string>();
  for (const poolId of new Set(poolIds)) {
    const id = universeIdOf(poolId);
    const fdcId = id ? dbFood(id)?.fdcId : undefined;
    if (fdcId !== undefined && Number.isInteger(fdcId) && fdcId > 0) bySource.set(String(fdcId), poolId);
    if (bySource.size >= UNIVERSE_REF_LIMIT) break;
  }
  if (bySource.size === 0) return {};
  try {
    const catalog = await admin.from("catalog_foods").select("id,source_id")
      .eq("source", "fdc_sr_legacy").in("source_id", [...bySource.keys()]);
    if (catalog.error) throw catalog.error;
    const poolIdOf = new Map<number, string>();
    for (const row of (catalog.data ?? []) as { id: number; source_id: string }[]) {
      const poolId = bySource.get(row.source_id);
      if (poolId) poolIdOf.set(row.id, poolId);
    }
    if (poolIdOf.size === 0) return {};
    const revisions = await admin.from("catalog_food_revisions").select("id,catalog_food_id")
      .eq("is_active", true).in("catalog_food_id", [...poolIdOf.keys()]);
    if (revisions.error) throw revisions.error;
    const active = new Map<number, number>();
    for (const row of (revisions.data ?? []) as { id: number; catalog_food_id: number }[]) {
      active.set(row.catalog_food_id, row.id);
    }
    const minted = await Promise.all([...poolIdOf.entries()].map(async ([catalogFoodId, poolId]) => {
      const revisionId = active.get(catalogFoodId);
      if (revisionId === undefined) return null;
      const { data, error } = await admin.rpc("get_or_create_food_ref", {
        p_user_id: userId, p_kind: "catalog", p_catalog_food_id: catalogFoodId, p_user_food_id: null,
      });
      if (error || typeof data !== "string") return null;
      return [poolId, { foodRefId: data, catalogFoodRevisionId: revisionId }] as const;
    }));
    return Object.fromEntries(minted.filter((row): row is NonNullable<typeof row> => row !== null));
  } catch (error) {
    // Ids and codes only: no food names, no account data.
    console.warn("[universe-refs] lookup failed; universe rows stay unresolved",
      { code: (error as { code?: string } | null)?.code ?? "unknown", requested: bySource.size });
    return {};
  }
}
