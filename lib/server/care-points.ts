import "server-only";

/**
 * UI-NEEDS SPROUT-CARE item 1: the Seeds ledger. `care_points_sync` (migration 20261225090100)
 * does all the eligibility work server-side; this module only calls it and shapes the answer.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type { CareLedgerRow, CarePointsResponse } from "@/lib/care/contract";

/** Recomputes every rule for `localDate` (and its week) and settles whatever has closed. */
export async function syncCarePoints(
  client: SupabaseClient, userId: string, localDate: string, zone: string,
): Promise<void> {
  const { error } = await client.rpc("care_points_sync",
    { p_user_id: userId, p_local_date: localDate, p_zone: zone });
  if (error) {
    if (error.code === "22023") throw new HttpError(400, "bad_request", "That date or zone could not be used.");
    throw new HttpError(502, "care_points_sync_failed", "Seeds could not be updated. Try again.", { cause: error });
  }
}

type Row = { id: string; kind: string; delta: number; local_date: string; status: string; source: unknown };
type DeltaRow = { delta: number; status: string };

/**
 * The caller's own ledger, read straight through RLS (no RPC needed for a plain read).
 * `balance`/`pending` sum every settled/pending row, not only the page `recent` shows (Sol
 * review finding: summing only the newest 200 rows disagreed with `care_purchase`'s own
 * full-ledger balance check once an account passed 200 ledger rows).
 */
export async function readCarePoints(
  client: SupabaseClient, userId: string, limit = 20,
): Promise<CarePointsResponse> {
  const [totals, recentRows] = await Promise.all([
    client.from("care_points_ledger").select("delta, status").eq("user_id", userId)
      .in("status", ["settled", "pending"]),
    client.from("care_points_ledger").select("id, kind, delta, local_date, status, source")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(limit),
  ]);
  if (totals.error) throw new HttpError(502, "care_points_read_failed", "Seeds could not be read.", { cause: totals.error });
  if (recentRows.error) {
    throw new HttpError(502, "care_points_read_failed", "Seeds could not be read.", { cause: recentRows.error });
  }
  const all = (totals.data ?? []) as DeltaRow[];
  const balance = all.filter((r) => r.status === "settled").reduce((sum, r) => sum + r.delta, 0);
  const pending = all.filter((r) => r.status === "pending").reduce((sum, r) => sum + r.delta, 0);
  const recent: CareLedgerRow[] = ((recentRows.data ?? []) as Row[]).map((r) => ({
    id: r.id, kind: r.kind as CareLedgerRow["kind"], delta: r.delta, localDate: r.local_date,
    status: r.status as CareLedgerRow["status"],
    itemId: typeof (r.source as { itemId?: unknown })?.itemId === "string"
      ? (r.source as { itemId: string }).itemId : null,
  }));
  return { balance, pending, recent };
}
