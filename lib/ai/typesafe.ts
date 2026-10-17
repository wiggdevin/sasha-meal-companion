import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  callModel, CallRefused, ProviderHttpError, SchemaRejection, type Ledger,
} from "@/lib/ai/call";
import { CALL_REGISTRY, type CallSite } from "@/lib/ai/call-registry";
import { JEV_MODEL } from "@/lib/ai/models";
import { JEV_HEALTH_REFUSAL, jevHealthGateOn } from "@/lib/ai/jev-health";
import {
  jevCarriesHealth, jevProvenance, type JevPayload, type JevPurpose,
} from "@/lib/ai/payloads";
import { claimJevCall } from "@/lib/ai/request-budget";
import { adminClient } from "@/lib/server/admin";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const REQUEST_MODEL = JEV_MODEL;
const DEFAULT_DEADLINE_MS = 3_000;
const RETRY_BACKOFF_MS = 400;
const SDK_VERSION = "http-v1";
const RETRYABLE_STATUSES = new Set([429, 529]);
const INPUT_USD_PER_MILLION = 0.042;
const CAP_WARNING_INTERVAL_MS = 60_000;

let lastCapWarningAt = Number.NEGATIVE_INFINITY;
let lastMissingUserWarningAt = Number.NEGATIVE_INFINITY;

function warn(reason: string, key?: string): void {
  const safeReason = key ? reason.replaceAll(key, "[redacted]") : reason;
  console.warn("[typesafe] " + safeReason);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnDailyCap(): void {
  const now = Date.now();
  if (now - lastCapWarningAt < CAP_WARNING_INTERVAL_MS) return;
  lastCapWarningAt = now;
  warn("skipped: daily cap");
}

function warnMissingUserId(): void {
  const now = Date.now();
  if (now - lastMissingUserWarningAt < CAP_WARNING_INTERVAL_MS) return;
  lastMissingUserWarningAt = now;
  warn("systemOne without userId: daily cap not enforced");
}

export const TYPESAFE_ENABLED = Boolean(process.env.TYPESAFE_API_KEY);

// The question and answer shapes live in lib/ai/jev-types.ts, which has no runtime imports, so the
// payload builders (lib/ai/payloads.ts) can name them from client-reachable code.
export type {
  Answers, ChoiceAnswer, ChoiceQuestion, NoulAnswer, NoulQuestion, Question, Questions, ScoreAnswer,
  ScoreQuestion,
} from "@/lib/ai/jev-types";
export { choice, noul, score } from "@/lib/ai/jev-types";
import type { Answers, Question, Questions } from "@/lib/ai/jev-types";

/** The purpose is the payload's own (lib/ai/payloads.ts); it is never passed separately. */
export type SystemOneOptions = {
  deadlineMs?: number;
  userId?: string;
  signal?: AbortSignal;
  /**
   * Phase 18 W10, D9 item 4: the suggestion short-list check is a short, measured call with no
   * retry — unlike every other Jev caller, which keeps the default one retry on 429/529.
   */
  noRetry?: boolean;
};

const probability = z.number().min(0).max(1);

function keyedProbabilities(keys: string[]): z.ZodType {
  return z.object(Object.fromEntries(keys.map((key) => [key, probability]))).strict();
}

function answerSchema(question: Question): z.ZodType {
  if (question.type === "noul") {
    return z.object({ type: z.literal("noul"), noul: probability }).strict();
  }
  if (question.type === "choice") {
    const keys = Object.keys(question.criteria);
    if (keys.length === 0) return z.never();
    return z.object({
      type: z.literal("choice"),
      choice: z.enum(keys as [string, ...string[]]),
      probabilities: keyedProbabilities(keys),
      confidence: probability,
    }).strict();
  }
  const keys = question.criteria.map((_, index) => String(index));
  const legend = z.object(Object.fromEntries(
    question.criteria.map((level, index) => [String(index), z.literal(level)]),
  )).strict();
  return z.object({
    type: z.literal("score"),
    // The legend's own range: a score past it is a malformed answer (→ null and the non-Jev
    // path), not a ranking input the 0..n-1 plausibility math would silently mis-scale.
    score: z.number().min(0).max(keys.length - 1),
    legend,
    probabilities: keyedProbabilities(keys),
    confidence: probability,
  }).strict();
}

/** The envelope every answer arrives in. The answers themselves are judged per question. */
const ENVELOPE = z.object({
  model: z.string().min(1),
  answers: z.unknown(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).strict(),
}).strict();

type JevResult = { model: string; answers: unknown; inputTokens: number; outputTokens: number };

function parseAnswers<Q extends Questions>(questions: Q, answers: unknown): Answers<Q> {
  const shape = Object.fromEntries(
    Object.entries(questions).map(([name, question]) => [name, answerSchema(question)]),
  );
  const parsed = z.object(shape).strict().safeParse(answers);
  if (!parsed.success) throw new SchemaRejection("malformed answer");
  return parsed.data as Answers<Q>;
}

/**
 * Whether a provider error keeps only its status, in `ai_calls.error` and in the log: every purpose
 * whose request carries the user's own content (D1), since a provider error body may echo it
 * (Phase 18 W5b, Sol r1 WARN; widened to every user-content purpose by W068). Food-only (D0)
 * evals keep the first 200 body characters.
 */
function redactsErrors(purpose: string): boolean {
  return (CALL_REGISTRY as Record<string, CallSite>)[purpose]?.dataClass !== "D0";
}

/** The Jev transport: one POST, provider I/O only. A non-2xx keeps the first 200 body chars, or
 *  only its status for a redacted purpose. */
async function postSystemOne(body: string, key: string, signal: AbortSignal, redact: boolean): Promise<JevResult> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body,
    signal,
  });
  if (!response.ok) {
    if (redact) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderHttpError(response.status, `HTTP ${response.status}`);
    }
    const detail = (await response.text()).slice(0, 200);
    throw new ProviderHttpError(response.status, `HTTP ${response.status}: ${detail}`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new SchemaRejection("malformed answer");
  }
  const envelope = ENVELOPE.safeParse(json);
  if (!envelope.success) throw new SchemaRejection("malformed answer");
  const { model, answers, usage } = envelope.data;
  return { model, answers, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

/** Why the call degraded, for the one warning line; null when it already warned (the cap). */
function degradeReason(error: unknown): string | null {
  if (error instanceof JevSkip || error instanceof CallRefused) return error.message;
  if ((error as { code?: unknown } | null)?.code === "spend_cap") {
    warnDailyCap();
    return null;
  }
  if (error instanceof SchemaRejection) return "malformed answer";
  if (error instanceof ProviderHttpError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "request timed out";
  return `request failed: ${errorMessage(error)}`;
}

/** A Jev-only admission refusal (no key, request budget spent): no row, a null answer. */
class JevSkip extends Error {}

/**
 * The ledger a Jev call is governed by. No user: none (warned). No admin client: the call is
 * skipped (scale S2: spend checks fail closed); Jev degrades to null as for any other failure.
 */
function jevLedger(userId: string | undefined): Ledger | null {
  if (!userId) {
    warnMissingUserId();
    return null;
  }
  try {
    return { userId, admin: adminClient() };
  } catch (error) {
    console.error("ai spend ledger unavailable; skipping the Jev call (fail closed)", { error });
    throw new JevSkip("spend ledger unavailable");
  }
}

/**
 * Jev is an accelerator: every provider, transport, validation, or logging failure degrades to
 * null and never blocks.
 *
 * Phase 13 §9 R3: the only input is a payload a builder in lib/ai/payloads.ts minted — never a raw
 * `state: unknown`. callModel (lib/ai/call.ts) refuses a value no builder made, a purpose missing
 * from the call registry, or a data class Jev is not cleared for, before anything is serialised;
 * it then checks the circuit, reserves against the shared daily caps (no per-user queue: a 3 s
 * accelerator never waits behind a 20 s coach call) and writes the one `ai_calls` row.
 */
export async function systemOne<P extends JevPurpose, Q extends Questions>(
  payload: JevPayload<P, Q>,
  options: SystemOneOptions = {},
): Promise<Answers<Q> | null> {
  const key = process.env.TYPESAFE_API_KEY;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  let body = "";
  try {
    return await callModel({
      payload, provenance: jevProvenance,
      target: () => ({ provider: "typesafe", model: REQUEST_MODEL, sdkVersion: SDK_VERSION }),
      admit: () => {
        if (!key) throw new JevSkip("TYPESAFE_API_KEY is not configured");
        // OD12: while the health gate is on, a payload that may carry health context never
        // leaves; it degrades to null like any other skip (no request, no row).
        if (jevCarriesHealth(payload) && jevHealthGateOn()) throw new JevSkip(JEV_HEALTH_REFUSAL);
        body = JSON.stringify({ state: payload.state, model: REQUEST_MODEL, questions: payload.questions });
        const logicalCallKey = createHash("sha256")
          .update(payload.purpose).update("\0").update(body).digest("hex");
        if (!claimJevCall(payload.purpose, logicalCallKey)) throw new JevSkip("skipped: request budget");
      },
      ledger: () => jevLedger(options.userId),
      inputHash: () => `\\x${createHash("sha256").update(body).digest("hex")}`,
      signal: options.signal,
      // A deadline shorter than the default is the caller's own latency budget (a chip's ranking),
      // so missing it is not counted against Jev's circuit (W068).
      callerDeadline: deadlineMs < DEFAULT_DEADLINE_MS,
      policy: {
        attempts: options.noRetry ? 1 : 2, budgetMs: deadlineMs, attemptMs: deadlineMs,
        backoffMs: [RETRY_BACKOFF_MS],
        retryable: (e) => !options.noRetry && e instanceof ProviderHttpError
          && RETRYABLE_STATUSES.has(e.status),
      },
      transport: { send: (signal) => postSystemOne(body, key ?? "", signal, redactsErrors(payload.purpose)) },
      accept: (result) => parseAnswers(payload.questions, result.answers),
      price: (_model, billed) => billed.inputTokens * INPUT_USD_PER_MILLION / 1_000_000,
      ledgerModel: (result) => result.model,
      // Input-only pricing: the request body's bytes bound its tokens.
      maxAttemptCostUsd: () => (Buffer.byteLength(body, "utf8") + 1024) * INPUT_USD_PER_MILLION / 1_000_000,
    });
  } catch (error) {
    const reason = degradeReason(error);
    if (reason) warn(reason, key);
    return null;
  }
}
