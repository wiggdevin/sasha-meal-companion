import type { SupabaseClient } from "@supabase/supabase-js";
import type { Intent, IntentFallbackReason, IntentResult } from "@/lib/coach/intent";

const INSERT_WARNING_THROTTLE_MS = 60_000;
let lastInsertWarningAt = Number.NEGATIVE_INFINITY;

function warnInsertFailure(error: unknown): void {
  const now = Date.now();
  if (now >= lastInsertWarningAt && now - lastInsertWarningAt < INSERT_WARNING_THROTTLE_MS) return;
  lastInsertWarningAt = now;
  const code = typeof error === "object" && error !== null && "code" in error
      && typeof error.code === "string"
    ? error.code.slice(0, 64)
    : "unknown";
  console.warn(`[coach] intent telemetry insert failed: ${code}`);
}

export type CoachIntentEvent = {
  intent: Intent | null;
  winningConfidence: number | null;
  minArgumentConfidence: number | null;
  fastPathTaken: boolean;
  fallbackReason: IntentFallbackReason;
  latencyMs: number;
};

export function intentEvent(
  result: IntentResult | null,
  fastPathTaken: boolean,
  fallbackReason: IntentFallbackReason,
  latencyMs: number,
): CoachIntentEvent {
  const argumentConfidences = result === null ? [] : Object.values(result.argConfidence);
  return {
    intent: result?.intent ?? null,
    winningConfidence: result?.confidence ?? null,
    minArgumentConfidence: argumentConfidences.length === 0
      ? null : Math.min(...argumentConfidences),
    fastPathTaken,
    fallbackReason,
    latencyMs: Math.max(0, Math.round(latencyMs)),
  };
}

/** Best-effort and privacy-safe: this row never contains the utterance, arguments, or food names. */
export async function recordCoachIntentEvent(
  admin: SupabaseClient,
  userId: string,
  event: CoachIntentEvent,
): Promise<void> {
  try {
    const { error } = await admin.from("coach_intent_events").insert({
      user_id: userId,
      intent: event.intent,
      winning_confidence: event.winningConfidence,
      min_argument_confidence: event.minArgumentConfidence,
      fast_path_taken: event.fastPathTaken,
      fallback_reason: event.fallbackReason,
      latency_ms: event.latencyMs,
    });
    if (error) warnInsertFailure(error);
  } catch (error) {
    warnInsertFailure(error);
  }
}
