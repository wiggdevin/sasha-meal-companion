import "server-only";

/** UI-NEEDS SPROUT-CARE item 3: accolade grants, read through RLS; written by care_accolades_sync. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type { CareAccolade, CareAccoladeKey } from "@/lib/care/contract";

export async function syncCareAccolades(
  client: SupabaseClient, userId: string, localDate: string, zone: string,
): Promise<void> {
  const { error } = await client.rpc("care_accolades_sync",
    { p_user_id: userId, p_local_date: localDate, p_zone: zone });
  if (error) {
    throw new HttpError(502, "care_accolades_sync_failed", "Accolades could not be updated. Try again.",
      { cause: error });
  }
}

type Row = { key: string; version: number; earned_at: string; evidence: unknown; seen_at: string | null };

export async function readCareAccolades(
  client: SupabaseClient, userId: string, unseenOnly: boolean,
): Promise<CareAccolade[]> {
  let query = client.from("care_accolades").select("key, version, earned_at, evidence, seen_at").eq("user_id", userId);
  if (unseenOnly) query = query.is("seen_at", null);
  const { data, error } = await query.order("earned_at", { ascending: false });
  if (error) throw new HttpError(502, "care_accolades_read_failed", "Accolades could not be read.", { cause: error });
  return (data as Row[] ?? []).map((r) => ({
    key: r.key as CareAccoladeKey, version: r.version, earnedAt: r.earned_at, evidence: r.evidence,
    seenAt: r.seen_at,
  }));
}

export async function markCareAccoladesSeen(
  client: SupabaseClient, userId: string, keys: string[],
): Promise<number> {
  const { data, error } = await client.rpc("care_accolades_seen", { p_user_id: userId, p_keys: keys });
  if (error) throw new HttpError(502, "care_accolades_seen_failed", "That could not be saved.", { cause: error });
  return typeof data === "number" ? data : 0;
}
