/**
 * Is this failure about CAPACITY rather than about the request?
 *
 * A model that is overloaded (503) or out of quota (429) will answer the same way to the same
 * request a moment later, so retrying it buys nothing and costs the caller its whole budget —
 * measured 2026-09-18, where a coach turn spent 30 s on three attempts at a model that was simply
 * full before it could try another one. A caller with a second model to try passes
 * `abandonOnCapacity` to `generateStructured` and gets the failure at once (T6 §5).
 *
 * It lives beside lib/ai/adapter.ts rather than inside it because the adapter is already at its
 * size limit, and because this is a judgement about an error, not a step of the call.
 *
 * Pure. No I/O.
 */

export function isCapacityFailure(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 503 || status === 429) return true;
  if (!(e instanceof Error)) return false;
  // An open circuit (lib/ai/circuit.ts) is per model since 2026-10-02: the model is out, the key
  // and the request are not, so another model is worth a try (DeepSeek audit round 5, MED).
  if (e.message.startsWith("circuit open")) return true;
  return /\b(503|429)\b|unavailable|overloaded|resource[_ ]exhausted|quota/i.test(e.message);
}

/**
 * Is there any point trying a DIFFERENT model on the same key?
 *
 * Only for a model that is out of capacity. A 429 is the KEY's quota, not the model's, so the
 * second model meets the same wall and the turn pays twice for one answer. A schema failure is
 * OURS — a second model refuses the same reply for the same reason. Neither is worth a second
 * call (Grok pass 1, MEDIUM 17).
 */
export function worthAnotherModel(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 429) return false;
  if (isPermissionDeniedFailure(e)) return false;
  if (e instanceof Error && /schema|quota|resource[_ ]exhausted/i.test(e.message)) return false;
  return isCapacityFailure(e);
}

/**
 * Is this the PROJECT itself being denied, rather than a capacity wall? 2026-10-06: Gemini started
 * answering every call on the production key with HTTP 403 "PERMISSION_DENIED: Your project has
 * been denied access. Please contact support." — distinct from a quota 429 or an overloaded 503:
 * the key and the project are blocked outright, on EVERY model that key can name, not just the one
 * that happened to be called. Retrying the same key, on this model or the capture pin
 * (lib/ai/lanes.ts), buys nothing (`worthAnotherModel` above returns false for it on purpose) — the
 * only thing worth trying is a DIFFERENT PROVIDER entirely (lib/ai/provider-fallback.ts,
 * lib/ai/capture.ts, lib/server/coach-transcribe.ts), and the circuit should open at once rather
 * than wait for the usual five-failures-in-ten-minutes window (lib/ai/circuit.ts), since every
 * further call on this key fails the same way.
 *
 * Scoped to a `ProviderHttpError` the Gemini transport raised (lib/ai/adapter.ts geminiHttpError):
 * an unrelated 403 elsewhere in the app (e.g. `media_not_owned`) is a different kind of error
 * entirely and must never trip a provider's circuit.
 */
export function isPermissionDeniedFailure(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (status !== 403) return false;
  return e instanceof Error && /permission[_ ]denied|denied access/i.test(e.message);
}
