/**
 * The `ai_calls` ledger: the row each outcome writes, and the write itself. (The per-instance
 * spend lock that used to live here is gone: lib/ai/spend.ts reserves against the caps in the
 * database, across every instance — scale S2.) lib/ai/call.ts (callModel) is the only
 * writer of a model-call row; lib/server/capture.ts records a capture refused at its hard cap
 * through `writeBlockedCall`. No provider transport lives here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ProviderResult = { text: string; inputTokens: number; outputTokens: number; usageKnown?: boolean };
// permission_denied (2026-10-06): a 403 denying the project; opens the circuit on the first row.
export type AiStatus =
  "ok" | "schema_invalid" | "provider_error" | "timeout" | "blocked" | "error" | "permission_denied";
/** Tokens a provider billed; summed over every answered attempt of one logical call. */
export type Billed = { inputTokens: number; outputTokens: number };

export type LedgerEntry = {
  userId: string; purpose: string; provider: string; model: string; sdkVersion: string;
  inputHash: string; started: number; status: AiStatus; billed: Billed | null; costUsd: number;
  error: string | null;
  /** The spend reservation the call settles (scale S2); a sweep charges this row's cost to it. */
  spendReservationId?: string | null;
};

/** One `ai_calls` row. `billed` is null (zero tokens) when no attempt was answered. */
export function aiCallRow(entry: LedgerEntry): Record<string, unknown> {
  return {
    user_id: entry.userId, purpose: entry.purpose, provider: entry.provider, model_id: entry.model,
    sdk_version: entry.sdkVersion, input_tokens: entry.billed?.inputTokens ?? 0,
    output_tokens: entry.billed?.outputTokens ?? 0, latency_ms: Date.now() - entry.started,
    input_hash: entry.inputHash, cost_estimate: entry.costUsd, status: entry.status,
    error: entry.error,
    ...(entry.spendReservationId ? { spend_reservation_id: entry.spendReservationId } : {}),
  };
}

export async function writeAiCall(admin: SupabaseClient, row: Record<string, unknown>): Promise<void> {
  let error: unknown;
  try {
    ({ error } = await admin.from("ai_calls").insert(row));
  } catch (thrown) {
    error = thrown;
  }
  if (error) {
    // A failed write here loses the call's ledger row (the caps settle separately through
    // ai_spend_settle). Do not throw on top of a result or an error the caller already has.
    console.error("ai_calls insert failed", {
      user_id: row.user_id, purpose: row.purpose, provider: row.provider, error,
    });
  }
}

/** The row a capture refused at its daily hard cap leaves: no provider call, zero cost. */
export async function writeBlockedCall(admin: SupabaseClient, call: {
  userId: string; purpose: string; provider: string; model: string; sdkVersion: string;
  inputHash: string; error: string;
}): Promise<void> {
  await writeAiCall(admin, {
    user_id: call.userId, purpose: call.purpose, provider: call.provider, model_id: call.model,
    sdk_version: call.sdkVersion, input_hash: call.inputHash, cost_estimate: 0,
    status: "blocked", error: call.error,
  });
}
