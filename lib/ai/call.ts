/**
 * callModel: the one governed path for every model call. Every lane (Gemini structured in
 * lib/ai/adapter.ts, Gemini grounded in lib/ai/gemini-grounded.ts, Jev in lib/ai/typesafe.ts) hands
 * over a builder-made payload, its target and a transport that does provider I/O only. callModel
 * owns the rest, in this order:
 *
 *   1. builder provenance: a payload no builder minted is refused (Phase 13 §9 R3);
 *   2. registry refusal (`callRefusal`): unregistered purpose, wrong provider, uncleared class;
 *   3. attestation, when the provider and data class require it (any non-D0 Gemini call);
 *   4. the lane's own admission (`admit`), for example Jev's per-request budget;
 *   5. the circuit breaker, read from `ai_calls`;
 *   6. the spend reservation: the call's maximum estimated cost is held against the user's daily
 *      cap and the global daily ceiling in one database transaction every instance shares
 *      (lib/ai/spend.ts, scale S2); a failed reservation refuses (fail closed);
 *   7. the transport: every attempt, its deadline, backoff and the whole-call budget;
 *   8. exactly one `ai_calls` row per logical call, ok or classified failure, carrying the billed
 *      tokens of every answered attempt (a schema-rejected answer is billed too), and then the
 *      reservation settled to that row's cost (0 when no attempt ran).
 *
 * Steps 1 to 6 refuse with no row and no provider I/O. Retries live here, not in a transport: the
 * billed-token sum and the one-row rule need to see every attempt.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertGeminiAttested, assertOpenRouterAttested } from "@/lib/ai/attestation";
import {
  CALL_REGISTRY, callRefusal, type CallProvider, type CallSite, type DataClass,
} from "@/lib/ai/call-registry";
import { aiCallRow, type AiStatus, type Billed, writeAiCall } from "@/lib/ai/call-ledger";
import { assertCircuitClosed } from "@/lib/ai/circuit";
import { isPermissionDeniedFailure } from "@/lib/ai/failures";
import { reserveSpend, settleSpend } from "@/lib/ai/spend";
import { CALLER_ABORT_ERROR } from "@/lib/ai/call-abort";

export type { Billed } from "@/lib/ai/call-ledger";
export { CALLER_ABORT_ERROR } from "@/lib/ai/call-abort";

export class SchemaRejection extends Error {}

/**
 * A well-formed reply that says the input holds nothing usable (an unreadable label). Recorded as
 * schema_invalid, NOT ok, so the propose route's duplicate probe never treats it as a draft, the
 * circuit never counts it (the provider answered), and its tokens are still billed. Final: a
 * second attempt reads the same photo the same way, so no lane retries it.
 */
export class UnusableReply extends SchemaRejection {
  constructor(reason: string) { super(`reply refused: ${reason}`); this.name = "UnusableReply"; }
}

/** A reply cut off mid-JSON (the output cap, a dropped stream) is the wrong shape, not a failed
 *  call, so it is recorded as schema_invalid like any reply the schema cannot accept (2026-09-15). */
export function parseModelJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch (e) {
    throw new SchemaRejection(`model output is not valid JSON: ${e instanceof Error ? e.message : "parse failed"}`);
  }
}
export class ProviderHttpError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "ProviderHttpError"; }
}
/** A refusal before any I/O: provenance, registry or clearance. The message starts "refused: ". */
export class CallRefused extends Error {
  constructor(reason: string) { super(`refused: ${reason}`); this.name = "CallRefused"; }
}

export function classifyFailure(e: unknown): AiStatus {
  if (e instanceof SchemaRejection) return "schema_invalid";
  // Checked before the general ProviderHttpError case: a 403 PERMISSION_DENIED is the whole
  // project being denied, not an ordinary provider hiccup, and lib/ai/circuit.ts reads this exact
  // status to open the circuit on the first occurrence rather than waiting for five in ten minutes.
  if (isPermissionDeniedFailure(e)) return "permission_denied";
  if (e instanceof ProviderHttpError) return "provider_error";
  if (e instanceof Error && (e.name === "AbortError" || /timed? ?out/i.test(e.message))) return "timeout";
  return "error";
}

/**
 * Spec §2: Gemini carries user content only on the attested project; D0 (food-only) is exempt.
 * OpenRouter (owner request 2026-10-02) mirrors the same rule under its own attestation pair
 * (lib/ai/attestation.ts) — it forwards to a third party too, so it gets the same gate, not a
 * free pass just because it is a newer lane.
 */
export function attestationRequired(provider: CallProvider, dataClass: DataClass): boolean {
  return (provider === "google" || provider === "openrouter") && dataClass !== "D0";
}

/**
 * Bound one provider attempt. The AbortSignal is what actually cancels the request (the
 * @google/genai SDK and fetch honour it); the timer is what guarantees this promise settles even
 * for a transport that ignores the signal. classifyFailure maps the rejection's "AbortError" name
 * onto the "timeout" ai_calls status.
 */
export async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`the provider did not answer within ${ms}ms`);
      err.name = "AbortError";
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function callerAborted(): Error {
  const err = new Error("the caller stopped waiting for the model");
  err.name = "AbortError";
  return err;
}

/** Rejects as soon as `signal` aborts, even when the transport ignores its own abort signal. */
function untilAborted<T>(run: Promise<T>, signal: AbortSignal | undefined, abortError: () => Error): Promise<T> {
  if (!signal) return run;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) {
      // The send is already in flight: keep its later rejection from going unhandled (W068).
      run.catch(() => undefined);
      return onAbort();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    run.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A backoff that ends early when the caller aborts, so a stopped call never waits it out. */
function sleepUnlessAborted(sleep: (ms: number) => Promise<void>, ms: number,
  signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => { signal.removeEventListener("abort", done); resolve(); };
    signal.addEventListener("abort", done, { once: true });
    sleep(ms).then(done, done);
  });
}

export type RetryPolicy = {
  /** Total attempts, at least 1. */
  attempts: number;
  /** The whole call: every attempt and its backoff. Each attempt gets what is left. */
  budgetMs: number;
  /** Ceiling on one attempt, cut short by what is left of `budgetMs`. */
  attemptMs: number;
  /** The wait before attempt i + 1, taken only when the budget can still afford it. */
  backoffMs: readonly number[];
  /** Whether a failed attempt is worth another one. */
  retryable: (e: unknown) => boolean;
  /**
   * Asked before every attempt after the first, once the failed attempt was judged retryable
   * and the backoff is over. False stops the call there: no further attempt is sent, and the
   * last attempt's failure is recorded and thrown as usual. A caller that meters each provider
   * attempt against its own budget (lib/server/onboarding-extract.ts) claims the next slot here.
   */
  beforeRetry?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
};

/** Provider I/O only: no gate, no ledger. `send` resolves with billed tokens or throws. */
export type Transport<R extends Billed> = {
  /** Runs once, after every gate and before the first attempt (a Files API upload). */
  open?: () => Promise<void>;
  send: (signal: AbortSignal, model: string) => Promise<R>;
  /** Runs once after the last attempt, success or not. It must not throw. */
  close?: () => Promise<void>;
};

export type Ledger = { userId: string; admin: SupabaseClient };

export type ModelCall<R extends Billed, T> = {
  payload: { readonly purpose: string };
  /** The builder module's provenance read (geminiProvenance, jevProvenance). */
  provenance: (payload: unknown) => string | null;
  /** The provider, the model the row records and the SDK version. May throw before any I/O. */
  target: () => { provider: CallProvider; model: string; sdkVersion: string };
  /** The lane's own admission after the registry gates. Throws to refuse, with no row. */
  admit?: () => void;
  /** Where the circuit, the spend cap and the row are read and written. Null: none of the three
   *  (a Jev call with no user, or no admin client; Jev fails open). */
  ledger: () => Ledger | null;
  inputHash: () => string;
  /** The most one attempt can cost on `model` — a real upper bound (its output cap and input size
   *  at the model's price, or a configured ceiling where the price is unknown). Reserved against
   *  the daily caps, times `policy.attempts`, before any I/O (lib/ai/spend.ts). */
  maxAttemptCostUsd: (model: string) => number;
  /** The caller's own abort. No attempt starts after it fires; a running one rejects at once. */
  signal?: AbortSignal;
  /**
   * True when `policy.attemptMs` is the caller's own latency budget rather than a bound on a
   * healthy provider (a Jev ranking held to a few hundred ms). A deadline then records as a
   * caller abort, which the circuit does not count (W068).
   */
  callerDeadline?: boolean;
  abortError?: () => Error;
  policy: RetryPolicy;
  transport: Transport<R>;
  /** Judges an answered attempt. Throwing (SchemaRejection) fails it; its tokens stay billed. */
  accept: (result: R) => T;
  price: (model: string, billed: Billed) => number;
  /** Cost on top of tokens for the accepted attempt (search grounding). */
  surchargeUsd?: (result: R) => number;
  /** The model the provider says answered, when it differs from the requested one (Jev). */
  ledgerModel?: (result: R) => string;
  /** Debug and bench hook: sees each answered attempt before `accept`. */
  observe?: (model: string, result: R) => void;
};

export async function callModel<R extends Billed, T>(call: ModelCall<R, T>): Promise<T> {
  const abortError = call.abortError ?? callerAborted;
  if (call.signal?.aborted) throw abortError();
  const { purpose } = call.payload;
  if (call.provenance(call.payload) !== purpose) {
    throw new CallRefused("the payload was not made by this purpose's payload builder");
  }
  const { provider, model, sdkVersion } = call.target();
  const refusal = callRefusal(purpose, provider);
  if (refusal) throw new CallRefused(refusal);
  const site: CallSite = (CALL_REGISTRY as Record<string, CallSite>)[purpose];
  if (attestationRequired(provider, site.dataClass)) {
    if (provider === "openrouter") assertOpenRouterAttested(); else assertGeminiAttested();
  }
  call.admit?.();
  const ledger = call.ledger();
  const inputHash = call.inputHash();
  const started = Date.now();
  if (ledger) await assertCircuitClosed(ledger.admin, provider, model);

  const reserveUsd = call.maxAttemptCostUsd(model) * Math.max(1, call.policy.attempts);
  const reservation = ledger ? await reserveSpend(ledger.admin, ledger.userId, reserveUsd) : null;
  // The row names its reservation, so a sweep can charge this cost if the settle never lands.
  const record = (status: AiStatus, billed: Billed | null, error: string | null,
    costUsd: number, recordedModel = model): Promise<void> => (ledger
    ? writeAiCall(ledger.admin, aiCallRow({ userId: ledger.userId, purpose, provider,
      model: recordedModel, sdkVersion, inputHash, started, status, billed, costUsd, error,
      spendReservationId: reservation?.id ?? null }))
    : Promise.resolve());
  let actualUsd = 0;
  const settled = (status: AiStatus, billed: Billed | null, error: string | null, costUsd: number,
    recordedModel?: string): Promise<void> => {
    actualUsd = costUsd;
    return record(status, billed, error, costUsd, recordedModel);
  };
  try {
    // The reservation may have outlived the caller: no attempt starts after it stopped.
    if (call.signal?.aborted) throw abortError();
    try {
      await call.transport.open?.();
    } catch (e) {
      // Followups #14: open() runs once, before any attempt() calls send() — a Gemini Files API
      // 403 PERMISSION_DENIED during a large media upload fails here, not inside attempt()'s own
      // retry loop. Unclassified and unrecorded, this used to leave no "permission_denied" row for
      // assertCircuitClosed (lib/ai/circuit.ts) to find, so a project-wide denial on this path
      // alone never opened the circuit. Same classify+record attempt()'s own catch-all does, with
      // no billed tokens (no attempt reached send()) and no retry (open() is not per-attempt).
      // A caller that stopped during the upload is not a provider failure (W068).
      if (call.signal?.aborted) {
        await settled("timeout", null, CALLER_ABORT_ERROR, 0);
        throw abortError();
      }
      const message = e instanceof Error ? e.message : "unknown";
      await settled(classifyFailure(e), null, message, 0);
      throw e;
    }
    try {
      return await attempt(call, model, abortError, settled);
    } finally {
      await call.transport.close?.();
    }
  } finally {
    if (ledger && reservation) await settleSpend(ledger.admin, reservation, actualUsd);
  }
}

async function attempt<R extends Billed, T>(
  call: ModelCall<R, T>, model: string, abortError: () => Error,
  record: (status: AiStatus, billed: Billed | null, error: string | null, costUsd: number,
    recordedModel?: string) => Promise<void>,
): Promise<T> {
  const { policy, signal } = call;
  const sleep = policy.sleep ?? defaultSleep;
  const deadlineAt = Date.now() + policy.budgetMs;
  let billed = null as Billed | null;
  // 2026-10-02 DeepSeek audit: surchargeUsd used to be read only on the attempt accept() took, so
  // an answered-but-schema-invalid attempt's real dollar cost (OpenRouter's usage.cost) vanished
  // from the failure row entirely — the spend cap under-counted exactly what was billed.
  // Accumulated per answered attempt, same as `billed` tokens above: every attempt that reached
  // `send` and got a result is "answered", whether or not `accept` went on to take it.
  let surchargeUsd = 0;
  let lastError: unknown = null;
  // The last failure that was the provider's own, kept even when the caller stops later: an
  // abort never hides a real 503 from the circuit (W068).
  let providerError: unknown = null;
  const callersStop = (e: unknown): boolean => signal?.aborted === true
    || (call.callerDeadline === true && classifyFailure(e) === "timeout");
  for (let n = 0; n < policy.attempts; n++) {
    if (signal?.aborted || deadlineAt - Date.now() <= 0) break;
    if (n > 0 && policy.beforeRetry && !(await policy.beforeRetry())) break;
    const remainingMs = deadlineAt - Date.now();
    if (signal?.aborted || remainingMs <= 0) break;
    try {
      const result = await withDeadline(Math.min(policy.attemptMs, remainingMs), (deadline) =>
        untilAborted(call.transport.send(signal ? AbortSignal.any([deadline, signal]) : deadline,
          model), signal, abortError));
      call.observe?.(model, result);
      billed = {
        inputTokens: (billed?.inputTokens ?? 0) + result.inputTokens,
        outputTokens: (billed?.outputTokens ?? 0) + result.outputTokens,
      };
      surchargeUsd += call.surchargeUsd?.(result) ?? 0;
      const value = call.accept(result);
      const recordedModel = call.ledgerModel?.(result) ?? model;
      await record("ok", billed, null, call.price(recordedModel, billed) + surchargeUsd, recordedModel);
      return value;
    } catch (e) {
      lastError = e;
      if (!callersStop(e)) providerError = e;
      // A caller that stopped waiting gets no further attempt (W068).
      if (signal?.aborted || !policy.retryable(e)) break;
      // Back off only if there is budget left to back off into.
      const backoff = policy.backoffMs[n] ?? 0;
      if (n < policy.attempts - 1 && deadlineAt - Date.now() > backoff) {
        await sleepUnlessAborted(sleep, backoff, signal);
      }
      if (signal?.aborted) break;
    }
  }
  // No separate failure counter: this row (status != "ok") IS the durable record the circuit
  // breaker reads next time. A caller's own stop is recorded as one, but never counted there.
  const aborted = signal?.aborted === true;
  const failure = providerError ?? lastError;
  const stoppedByCaller = providerError === null && callersStop(lastError);
  const message = stoppedByCaller ? CALLER_ABORT_ERROR
    : failure instanceof Error ? failure.message : "unknown";
  await record(stoppedByCaller ? "timeout" : classifyFailure(failure), billed, message,
    billed ? call.price(model, billed) + surchargeUsd : 0);
  if (aborted) throw abortError();
  throw lastError instanceof Error ? lastError : new Error(message);
}
