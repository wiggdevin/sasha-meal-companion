/**
 * The ONLY module that writes catalog_* from a request path (spec "Security", contracts §8).
 * A review-blocking defect is any other module importing it, and any module other than this one
 * importing lib/server/admin.ts to write a catalog row.
 *
 * It accepts only a RevisionDraft the mappers built from a provider response — never a field
 * from a request body — and the GTIN, which is 14 validated digits by the time it arrives. The
 * whole write is one RPC call so it is one transaction: version, identity, revision,
 * nutrients, portions, ingredients, barcode and food_ref land together or not at all.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RevisionDraft } from "@/lib/catalog/off-map";
import { HttpError } from "@/lib/server/auth";

if (typeof window !== "undefined") {
  throw new Error("lib/server/catalog-writer.ts is server-only and must never reach the browser bundle.");
}

type WriteRow = { catalog_food_id: number; revision_id: number; version_label: string };

export async function writeProviderRevision(
  admin: SupabaseClient,
  source: "off" | "fdc_branded",
  gtin14: string,
  draft: RevisionDraft,
  userId: string
): Promise<{ catalogFoodId: number; revisionId: number; versionLabel: string }> {
  const { data, error } = await admin.rpc("catalog_write_provider_revision", {
    p_user_id: userId, p_source: source, p_gtin14: gtin14, p_draft: draft,
  });
  if (error) {
    // The provider and the database both speak in detail we never hand back to the client.
    console.error("[catalog-writer] provider write failed", source, error);
    throw new HttpError(502, "catalog_write_failed", "That product could not be cached.");
  }
  const row = (Array.isArray(data) ? data[0] : data) as WriteRow | null;
  if (!row) throw new HttpError(502, "catalog_write_failed", "That product could not be cached.");
  return {
    catalogFoodId: Number(row.catalog_food_id),
    revisionId: Number(row.revision_id),
    versionLabel: row.version_label,
  };
}
