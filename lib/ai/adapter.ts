/**
 * The Gemini structured lane: the transport (generateContent with a response schema, Files API
 * media) and the schema parse. Every gate, the retry loop and the `ai_calls` row belong to
 * callModel (lib/ai/call.ts). architecture.md §6.
 *
 * Model ids are LITERALS. An env-var-driven id, or a "latest" alias, would make
 * a silent provider change indistinguishable from a deploy, which is exactly
 * what the pin exists to prevent. The installed SDK major is asserted for the
 * same reason: a major upgrade gets its own canary, deliberately.
 */

import { geminiUsage } from "@/lib/ai/gemini-usage";
import { streamGemini } from "@/lib/ai/gemini-stream";
import { callModel, parseModelJson, SchemaRejection } from "@/lib/ai/call";
import { geminiHttpError } from "@/lib/ai/gemini-errors";
import type { ProviderResult } from "@/lib/ai/call-ledger";
import { geminiProvenance } from "@/lib/ai/gemini-payloads";
import type { GeminiPayload, GeminiPurpose, Media } from "@/lib/ai/payloads";
import { geminiConfig } from "@/lib/ai/gemini-config";
import { acceptRefused, geminiRetryable, type RefuseArg } from "@/lib/ai/refusal";
export { isCapacityFailure, worthAnotherModel } from "@/lib/ai/failures";
export { recentFailureCount } from "@/lib/ai/circuit";
export { classifyFailure, ProviderHttpError, SchemaRejection, withDeadline } from "@/lib/ai/call";
import sdkVersion from "@/lib/ai/sdk-version.json";

// The pinned ids, purposes and prices live in lib/ai/models.ts (T4). Re-exported here so every
// existing `from "@/lib/ai/adapter"` import keeps working.
import {
  estimateCostUsd, inputTokensUpperBound, modelProvider, MODELS, reserveCostUsd, type Purpose,
} from "@/lib/ai/models";
export { estimateCostUsd, GEMINI_COACH, GEMINI_FLASH, MODELS, PRICE_PER_MILLION_TOKENS, type Purpose }
  from "@/lib/ai/models";

/**
 * contracts §7: "Pinned SDK major for assertPinnedSdk(): @google/genai major = 2
 * (correction: the spec said 1 before install)". 2.21.x is what `pnpm add
 * @google/genai` put on main on 2026-09-10, and the spec's Test plan names the
 * same number. A major bump gets its own canary run, deliberately.
 */
export const PINNED_GENAI_MAJOR = 2;

/**
 * The exact SDK version is embedded in the server bundle. The production build compares this pin
 * with the installed package manifest, so runtime requests never depend on package-manager paths
 * or a manifest that Vercel's function bundler may omit.
 */
export function installedGenai(): { version: string; major: number } {
  return { version: sdkVersion.version, major: sdkVersion.major };
}

export function assertPinnedSdk(read: () => { version: string; major: number } = installedGenai): void {
  const { major } = read();
  if (major !== PINNED_GENAI_MAJOR) {
    throw new Error(
      `@google/genai major ${major} is installed; Phase 0 pins major ${PINNED_GENAI_MAJOR}`
    );
  }
}

import { createHash } from "node:crypto";
import { GoogleGenAI, type Part } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZodType } from "zod";
import { geminiRequestSchema, stripJsonFence } from "@/lib/ai/gemini-schema";
import { withMediaPart, type UploadedFile } from "@/lib/ai/gemini-media";

const RETRIES = 2;                    // 3 attempts in total
/**
 * The budget for one generateStructured call — ALL attempts and their backoff, not each attempt.
 * Applies when a caller passes no timeoutMs of its own.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 20_000;

/**
 * How long ONE attempt may run before it is abandoned and retried.
 *
 * Measured on the live provider with thinking at MINIMAL, the latencies are bimodal: a healthy
 * call answers in 1.2-3.2 s, a bad one never answers at all. Waiting longer does not rescue a
 * stall, so an attempt is cut well short of the call budget and the time goes to a retry instead.
 *
 * Six seconds is about twice the slowest healthy call seen, and — the reason it is not eight —
 * three attempts at six seconds still fit inside the 20 s call budget. At eight, the third retry
 * was squeezed out: a turn that stalled three times spent 8 + 8 + 2.7 s and gave up mid-attempt.
 */
export const ATTEMPT_TIMEOUT_MS = 6_000;

const BACKOFF_MS = [250, 1000];

export type { AiStatus, ProviderResult } from "@/lib/ai/call-ledger";
export type { Media } from "@/lib/ai/payloads";
export { INLINE_LIMIT_BYTES, withMediaPart, type UploadedFile } from "@/lib/ai/gemini-media";

/**
 * ai_calls.input_hash is bytea (hex literal). Hashes the media BYTES, never the upload uri — a
 * Files API uri is new on every upload, and the propose route must recognise a repeat photo.
 */
export function inputHashFor(parts: readonly Part[], media?: Media): string {
  const hash = createHash("sha256").update(JSON.stringify(parts));
  if (media) hash.update(media.mimeType).update(media.bytes);
  return "\\x" + hash.digest("hex");
}

export { geminiHttpError } from "@/lib/ai/gemini-errors";

async function geminiCall(
  model: string, parts: Part[], jsonSchema: unknown, maxOutputTokens?: number, signal?: AbortSignal,
  temperature: number = 0, onText?: (raw: string) => void,
): Promise<ProviderResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: key });
  const request = { model, contents: [{ role: "user", parts }],
    config: geminiConfig({ model, jsonSchema, temperature, maxOutputTokens, signal }) };
  try {
    if (onText) return await streamGemini(ai, request, onText);
    const res = await ai.models.generateContent(request);
    return { text: res.text ?? "", ...geminiUsage(res.usageMetadata) };
  } catch (e) {
    throw geminiHttpError(e) ?? e;
  }
}

/** A caller's routing decision for one call. Atomic: a provider never travels without its model. */
export type Provider = "google";
export type RouteOverride = { provider: Provider; modelId: string };

/**
 * The provider and the model one call will use, resolved from the caller's override and the
 * per-purpose table. A model the provider does not serve would be recorded under the wrong
 * provider, so it is refused here — before any spend, provider call or `ai_calls` row.
 */
export function resolveTarget(purpose: Purpose, route?: RouteOverride): { provider: Provider; model: string } {
  const model = route?.modelId ?? MODELS[purpose];
  const provider = route?.provider ?? "google";
  if (provider !== modelProvider(model)) {
    throw new Error(`model '${model}' is not served by provider '${provider}'`);
  }
  return { provider, model };
}

export type GenerateArgs<T> = {
  /**
   * Phase 13 §9 R3: the request content, as a payload builder in lib/ai/payloads.ts made it. It
   * carries the purpose, the parts and any media; nothing else reaches the provider. Narrowed to
   * `Purpose` (lib/ai/models.ts), not the wider `GeminiPurpose`: every purpose here needs a
   * `MODELS` entry for `resolveTarget`.
   */
  payload: GeminiPayload<Purpose & GeminiPurpose>;
  userId: string; schema: ZodType<T>; admin: SupabaseClient;
  /**
   * Caller-specified routing (T4), as one object: a half-filled pair is a type error, so the
   * provider and the model can never drift apart. Omitted, the per-purpose table decides.
   */
  route?: RouteOverride;
};
export type StructuredArgs<T> = GenerateArgs<T> & {
  maxOutputTokens?: number;
  /**
   * Ceiling on ONE provider attempt. The coach's wall-clock budget is only consulted between
   * turn steps, so without this an attempt that never returns hangs the whole request — with
   * RETRIES = 2 that is three unbounded waits, which is how a turn hung for three minutes on
   * 2026-09-13. Callers pass PER_CALL_TIMEOUT_MS; omitted, DEFAULT_CALL_TIMEOUT_MS applies.
   */
  timeoutMs?: number;
  /**
   * How long one attempt may run before it is abandoned and retried. Defaults to
   * ATTEMPT_TIMEOUT_MS. A stalled provider call never recovers, so this is deliberately far below
   * `timeoutMs` — the remaining budget is worth more spent on another attempt.
   */
  attemptTimeoutMs?: number;
  /**
   * Sampling temperature. Extraction purposes (label, photo, text to items) stay at 0, where a
   * deterministic reading is the point. The coach does NOT: at temperature 0 a model that slips
   * into a repetitive state cannot leave it, because the top token never changes. On 2026-09-14
   * that produced a reply which recited its own instructions back at the user for hundreds of
   * words ("zero exclamation marks anywhere in reply. clean valid format. standard json...").
   * A small non-zero temperature is the standard remedy for that degeneration.
   */
  temperature?: number;
  /** Hand a no-capacity failure back at once, for a caller with another model (lib/ai/failures.ts). */
  abandonOnCapacity?: boolean;
  /** Asked before each retry; false stops the call (lib/ai/call.ts RetryPolicy.beforeRetry). */
  beforeRetry?: () => Promise<boolean>;
  /** The schema the PROVIDER is sent, when it must be stricter than the one the reply is parsed
   *  with. The coach sends one whose every key is required (lib/coach/wire.ts). */
  providerSchema?: ZodType;
  /** OD06: stream the reply; sees the raw text so far on each attempt (lib/ai/gemini-stream.ts). */
  onText?: (raw: string) => void;
} & RefuseArg<T>;
export type GenerateDeps = {
  sleep?: (ms: number) => Promise<void>;
  callGemini?: (model: string, parts: Part[], jsonSchema: unknown, maxOutputTokens?: number, signal?: AbortSignal, temperature?: number, onText?: (raw: string) => void) => Promise<ProviderResult>;
  uploadMedia?: (media: Media) => Promise<UploadedFile>;
  deleteMedia?: (name: string) => Promise<void>;
  /** Debug hook: sees each raw provider answer before the schema judges it (scripts only). */
  onProviderText?: (model: string, text: string) => void;
  /** Bench hook: sees each completed provider attempt's usage, including ones the schema rejects. */
  onProviderResult?: (model: string, result: ProviderResult) => void;
};

async function uploadToFiles(media: Media): Promise<UploadedFile> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: key });
  const file = await ai.files.upload({
    file: new Blob([media.bytes as BlobPart], { type: media.mimeType }),
    config: { mimeType: media.mimeType },
  });
  if (!file.uri || !file.name) throw new Error("the Files API returned no uri");
  return { uri: file.uri, name: file.name };
}

async function deleteFromFiles(name: string): Promise<void> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return;
  await new GoogleGenAI({ apiKey: key }).files.delete({ name });
}

export async function generateStructured<T>(
  args: StructuredArgs<T>, deps: GenerateDeps = {}
): Promise<T> {
  assertPinnedSdk();
  const { payload } = args;
  let parts: Part[] = [];
  let uploaded: UploadedFile | null = null;
  let jsonSchema: unknown;
  return callModel({
    payload, provenance: geminiProvenance,
    target: () => ({ ...resolveTarget(payload.purpose, args.route), sdkVersion: installedGenai().version }),
    ledger: () => ({ userId: args.userId, admin: args.admin }),
    inputHash: () => inputHashFor(payload.parts, payload.media),
    // One budget for the whole call, not one per attempt: three attempts at a per-attempt 20 s
    // cost 61 s inside a 75 s turn (2026-09-14). Each attempt gets whatever is left.
    policy: {
      attempts: RETRIES + 1, budgetMs: args.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      attemptMs: args.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS, backoffMs: BACKOFF_MS,
      retryable: geminiRetryable(args.abandonOnCapacity), beforeRetry: args.beforeRetry,
      sleep: deps.sleep,
    },
    transport: {
      open: async () => {
        jsonSchema = geminiRequestSchema(args.schema, args.providerSchema);
        ({ parts, uploaded } = await withMediaPart(payload.parts, payload.media,
          deps.uploadMedia ?? uploadToFiles));
      },
      send: (signal, model) => (deps.callGemini ?? geminiCall)(
        model, parts, jsonSchema, args.maxOutputTokens, signal, args.temperature ?? 0, args.onText),
      // architecture §6: "Provider files are deleted after every call that uses the Files API, in
      // a finally block". A delete that itself fails must not mask the call's own error.
      close: async () => {
        if (!uploaded) return;
        try { await (deps.deleteMedia ?? deleteFromFiles)(uploaded.name); }
        catch (e) { console.error("provider file delete failed", { name: uploaded.name, error: e }); }
      },
    },
    accept: (result) => {
      const parsed = args.schema.safeParse(parseModelJson(stripJsonFence(result.text)));
      if (!parsed.success) {
        throw new SchemaRejection(`model output failed the schema: ${parsed.error.message}`);
      }
      return acceptRefused(parsed.data, args.refuse);
    },
    price: (model, billed) => estimateCostUsd(model, billed.inputTokens, billed.outputTokens),
    maxAttemptCostUsd: (model) => reserveCostUsd(model, inputTokensUpperBound([...payload.parts.map((p) =>
      p.text ?? ""), JSON.stringify(geminiRequestSchema(args.schema, args.providerSchema))],
    payload.media ? 1 : 0), args.maxOutputTokens),
    observe: (model, result) => {
      deps.onProviderText?.(model, result.text);
      deps.onProviderResult?.(model, result);
    },
  });
}
