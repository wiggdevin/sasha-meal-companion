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
    if (error.code === "22023") throw new HttpError(400, "bad_request", "That zone could not be used.");
    throw new HttpError(502, "care_points_sync_failed", "Seeds could not be updated. Try again.", { cause: error });
  }
}

type Row = { id: string; kind: string; delta: number; local_date: string; status: string; source: unknown };

/**
 * The settled balance and pending sum over the WHOLE ledger, summed in SQL by `care_balance`
 * (migration 20270104090000). A plain select summed in JS stopped at the API's 1,000-row cap
 * with no sign of it (W067, audit A106), while `care_purchase` sums every row.
 */
export async function readCareBalance(
  client: SupabaseClient, userId: string,
): Promise<{ balance: number; pending: number }> {
  const { data, error } = await client.rpc("care_balance", { p_user_id: userId });
  const body = data as { balance?: unknown; pending?: unknown } | null;
  if (error || typeof body?.balance !== "number" || typeof body.pending !== "number") {
    throw new HttpError(502, "care_points_read_failed", "Seeds could not be read.", { cause: error ?? body });
  }
  return { balance: body.balance, pending: body.pending };
}

/** The caller's own ledger: the whole-ledger totals, and the newest `limit` rows through RLS. */
export async function readCarePoints(
  client: SupabaseClient, userId: string, limit = 20,
): Promise<CarePointsResponse> {
  const [totals, recentRows] = await Promise.all([
    readCareBalance(client, userId),
    client.from("care_points_ledger").select("id, kind, delta, local_date, status, source")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(limit),
  ]);
  if (recentRows.error) {
    throw new HttpError(502, "care_points_read_failed", "Seeds could not be read.", { cause: recentRows.error });
  }
  const recent: CareLedgerRow[] = ((recentRows.data ?? []) as Row[]).map((r) => ({
    id: r.id, kind: r.kind as CareLedgerRow["kind"], delta: r.delta, localDate: r.local_date,
    status: r.status as CareLedgerRow["status"],
    itemId: typeof (r.source as { itemId?: unknown })?.itemId === "string"
      ? (r.source as { itemId: string }).itemId : null,
  }));
  return { ...totals, recent };
}
