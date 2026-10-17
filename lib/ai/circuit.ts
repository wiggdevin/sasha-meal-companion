import type { SupabaseClient } from "@supabase/supabase-js";
import { CALLER_ABORT_ERROR, type AiStatus } from "@/lib/ai/call-ledger";

/**
 * Provider circuit breaker — split out of lib/ai/adapter.ts (T4, audit round 4) so the adapter
 * stays under the 400-line limit. Five failures in ten minutes open the circuit.
 *
 * Backed by `ai_calls` (audit #71): every AI-calling route is a Vercel serverless function with
 * no instance affinity, so a module-level failure counter is cleared on the next cold start and
 * a real outage never trips it. `ai_calls` already gets a row per failed call (`callModel`,
 * lib/ai/call.ts, writes `status` != "ok" on exhaustion) — the same durable store `assertTurnBudget`
 * already reads — so the count survives whichever instance answers next.
 */
const CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
const CIRCUIT_THRESHOLD = 5;

/**
 * The failures still inside the window, read from `ai_calls`. Split out so a test can read the
 * counter the circuit reads without opening the circuit; `assertCircuitClosed` defaults to the
 * real threshold, so production behavior is unchanged.
 */
/** The statuses that say the provider itself is unwell. A reply the schema rejected came from a
 *  provider that answered, and a refusal never reached it, so neither opens the circuit. */
const PROVIDER_FAILURES: AiStatus[] = ["provider_error", "timeout", "error"];

/**
 * 2026-10-06: a 403 PERMISSION_DENIED (lib/ai/failures.ts isPermissionDeniedFailure) says the
 * whole project is blocked, not that this one call was unlucky — every further call on the same
 * key fails identically. One row of it is enough to open the circuit; waiting for
 * CIRCUIT_THRESHOLD (five) would mean the fifth caller, not the first, is the one who stops paying
 * for a dead provider.
 */
const PERMISSION_DENIED_THRESHOLD = 1;

/**
 * Counted per model when a model is named (2026-10-02 live capture smoke): gemini-3.8-flash
 * answered 503 under demand for hours while 3.6 answered in a second on the same key, so a
 * circuit per provider let one overloaded model shut every Gemini call, fallbacks included.
 */
export async function recentFailureCount(
  admin: SupabaseClient, provider: string, model?: string, statuses: readonly AiStatus[] = PROVIDER_FAILURES,
): Promise<number> {
  const windowStart = new Date(Date.now() - CIRCUIT_WINDOW_MS).toISOString();
  // A failed read never blocks the AI path — the circuit breaker is a backstop, not a gate that
  // itself depends on a healthy database (matches assertTurnBudget; the spend reservation, by
  // contrast, fails closed — lib/ai/spend.ts). A read
  // that throws instead of returning an error counts the same.
  try {
    let query = admin.from("ai_calls").select("created_at, error").eq("provider", provider);
    if (model !== undefined) query = query.eq("model_id", model);
    const { data, error } = await query.in("status", statuses)
      .gte("created_at", windowStart);
    if (error) return 0;
    // A call its caller stopped says nothing about the provider (W068, lib/ai/call.ts).
    return ((data ?? []) as { error?: unknown }[]).filter((row) => row.error !== CALLER_ABORT_ERROR).length;
  } catch {
    return 0;
  }
}

export async function assertCircuitClosed(
  admin: SupabaseClient, provider: string, model?: string, threshold = CIRCUIT_THRESHOLD
): Promise<void> {
  const label = model ? `${provider} ${model}` : provider;
  // Checked first, and on its own one-row threshold: a project-wide denial is not a capacity
  // blip, so the usual five-in-ten-minutes window would still let four more callers burn a full
  // retry budget on a key that is already known to be dead. Scoped to the PROVIDER, not the
  // model, for "google" specifically (2026-10-06 Sol review): Gemini's 403 denies the whole
  // project, every model on the key alike, so a denial seen through one model (the coach pin)
  // must open the circuit for the other (the capture pin) too, not just its own. Every other
  // provider stays model-scoped, same as an ordinary failure — a catalog model reachable through
  // OpenRouter being denied says nothing about its neighbours on the same key.
  const deniedScope = provider === "google" ? undefined : model;
  const denied = await recentFailureCount(admin, provider, deniedScope, ["permission_denied"]);
  if (denied >= PERMISSION_DENIED_THRESHOLD) {
    throw new Error(`circuit open for ${label}: the provider denied this project's access`);
  }
  const recent = await recentFailureCount(admin, provider, model);
  if (recent >= threshold) {
    throw new Error(`circuit open for ${label}: ${threshold} failures in the last 10 minutes`);
  }
}

export { CIRCUIT_THRESHOLD, CIRCUIT_WINDOW_MS, PERMISSION_DENIED_THRESHOLD };
