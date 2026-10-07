import type { SupabaseClient } from "@supabase/supabase-js";
import { pilotSrLegacySource } from "@/lib/recipe-catalog/pilot-sr-legacy";

export type PilotCatalogIdentity = { catalogFoodId: number; revisionId: number };

/** Resolve reviewed pilot ingredients through the immutable USDA source key, not description. */
export async function resolvePilotCatalogRevisions(client: SupabaseClient,
  foodDbIds: readonly string[]): Promise<Map<string, PilotCatalogIdentity>> {
  const requested = [...new Set(foodDbIds)].map((foodDbId) =>
    ({ foodDbId, source: pilotSrLegacySource(foodDbId) }))
    .filter((item): item is { foodDbId: string; source: { source: "fdc_sr_legacy";
      sourceId: string; description: string } } =>
      item.source !== null);
  const result = new Map<string, PilotCatalogIdentity>();
  if (!requested.length) return result;
  const bySourceId = new Map(requested.map((item) => [item.source.sourceId, item.foodDbId]));
  const catalog = await client.from("catalog_foods").select("id,source_id")
    .eq("source", "fdc_sr_legacy").in("source_id", [...bySourceId.keys()]);
  if (catalog.error) throw new Error(`Pilot catalog identity lookup failed: ${catalog.error.message}`);
  const byCatalogId = new Map<number, string>();
  for (const row of catalog.data ?? []) {
    const foodDbId = bySourceId.get(row.source_id);
    if (!foodDbId) continue;
    if (byCatalogId.has(row.id)) throw new Error("Duplicate pilot catalog identity");
    byCatalogId.set(row.id, foodDbId);
  }
  if (!byCatalogId.size) return result;
  const revisions = await client.from("catalog_food_revisions")
    .select("id,catalog_food_id,description").eq("is_active", true)
    .in("catalog_food_id", [...byCatalogId.keys()]);
  if (revisions.error) throw new Error(`Pilot active revision lookup failed: ${revisions.error.message}`);
  for (const row of revisions.data ?? []) {
    const foodDbId = byCatalogId.get(row.catalog_food_id);
    if (!foodDbId) continue;
    const expected = requested.find((item) => item.foodDbId === foodDbId)?.source.description;
    if (row.description !== expected) {
      throw new Error(`Pilot catalog description differs from reviewed USDA row for ${foodDbId}`);
    }
    if (result.has(foodDbId)) throw new Error("Duplicate active pilot revision");
    result.set(foodDbId, { catalogFoodId: row.catalog_food_id, revisionId: row.id });
  }
  return result;
}
