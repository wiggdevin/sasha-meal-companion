/**
 * The OpenRouter structured-output transport. Owner request 2026-10-02: "can we use open router?
 * wire up my api key please and that way we can use any model we like" — Gemini had returned 429
 * "exceeded your current quota" and back-to-back 503s on both pinned models, 2026-09-16 and
 * 2026-09-24, failing coach turns outright. OpenAI-compatible chat completions at
 * https://openrouter.ai/api/v1/chat/completions: model ids are pinned in lib/ai/lanes.ts.
 * Every gate, the retry loop and the one
 * `ai_calls` row belong to callModel (lib/ai/call.ts), same as every other lane; this file is
 * provider I/O only.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZodType } from "zod";
import {
  callModel, parseModelJson, ProviderHttpError, SchemaRejection, schemaIssueSummary,
} from "@/lib/ai/call";
import { acceptRefused, isFinalReply, type RefuseArg } from "@/lib/ai/refusal";
import { toPlainJsonSchema } from "@/lib/ai/json-schema";
import { openRouterProvenance, type OpenRouterPayload } from "@/lib/ai/openrouter-payloads";
import { APP_NAME } from "@/lib/brand";
import { openRouterAttemptCeilingUsd, openRouterAttemptCost } from "@/lib/ai/spend";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const SDK_VERSION = "http-v1";
const RETRIES = 1;                 // 2 attempts in total — this is already a fallback call
const DEFAULT_CALL_TIMEOUT_MS = 20_000;
const ATTEMPT_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [500];
/** 429 (rate/quota) and 503 (no capacity) are worth one retry; everything else is ours or final. */
const RETRYABLE_STATUSES = new Set([429, 503]);

/** Strip the ```json … ``` wrapper a chat model adds around an object (same rule as the Gemini
 *  path, lib/ai/adapter.ts stripJsonFence — copied rather than imported so this transport has no
 *  dependency on another provider's module). */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

type OpenRouterResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The dollar cost OpenRouter itself billed this generation, read from `usage.cost` (requires
   *  the request's `usage.include: true`) — never estimated from a local price table, because an
   *  OpenRouter's price is not this app's to track (unlike lib/ai/models.ts's
   *  pinned, priced Gemini lane). Zero when the provider did not report it. */
  costUsd: number;
  /** Why the model stopped ("stop", "length"), named in a schema refusal so a reply cut off by the
   *  output cap reads apart from a wrong shape (W087). Null when the provider did not say. */
  finishReason?: string | null;
};

/**
 * One chat-completions call. Provider I/O only — no gate, no retry, no ledger (those are
 * callModel's job, lib/ai/call.ts). A non-2xx becomes a `ProviderHttpError` carrying the real
 * status, so `isCapacityFailure`/`worthAnotherModel` (lib/ai/failures.ts) read it the same way
 * they read a Gemini failure. The key is read here and only here (tests/ai/call-registry.test.ts)
 * and never appears in a thrown message or a log line.
 */
/** The deployment's own address (Vercel sets VERCEL_PROJECT_PRODUCTION_URL); never a literal. */
function siteUrl(): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}

/**
 * `data:audio/mpeg;base64,xxxx` -> `{ data: "xxxx", format: "mp3" }` — OpenRouter/OpenAI's
 * `input_audio` content part names a short format token, not a MIME type (2026-10-06).
 *
 * `audio/mp4` (the recorder's own first choice, lib/capture/presentation.ts AUDIO_MIME_TYPES: "Safari
 * and current Chrome record audio/mp4") maps to "m4a": OpenRouter's audio guide lists m4a among its
 * accepted formats and does not mention "mp4" as one, and an MP4 container holding only an AAC
 * audio track (no video) is exactly what the ".m4a" extension names — never send the container
 * name where the API expects the audio format token.
 */
function audioPart(dataUrl: string): { type: "input_audio"; input_audio: { data: string; format: string } } {
  const match = /^data:audio\/([a-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl);
  if (!match) throw new Error("refused: malformed audio data URL");
  const [, subtype, data] = match;
  const format = ({ mpeg: "mp3", mp4: "m4a", aac: "aac", wav: "wav" } as Record<string, string>)[subtype]
    ?? subtype;
  return { type: "input_audio", input_audio: { data, format } };
}

async function callOpenRouter(
  model: string, text: string, jsonSchema: unknown, temperature: number, signal: AbortSignal,
  maxTokens?: number, imageDataUrl?: string, schemaName = "coach_turn_step", fileDataUrl?: string,
  audioDataUrl?: string, onText?: (raw: string) => void,
): Promise<OpenRouterResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      // OpenRouter's own attribution headers (its docs ask for both); neither carries user data.
      "http-referer": process.env.OPENROUTER_SITE_URL || siteUrl(),
      "x-title": process.env.OPENROUTER_APP_NAME || APP_NAME,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: imageDataUrl || fileDataUrl || audioDataUrl
        ? [{ type: "text", text },
          ...(imageDataUrl ? [{ type: "image_url", image_url: { url: imageDataUrl } }] : []),
          ...(fileDataUrl ? [{ type: "file", file: { filename: "document.pdf", file_data: fileDataUrl } }] : []),
          ...(audioDataUrl ? [audioPart(audioDataUrl)] : [])]
        : text }],
      // A PDF is read by the model itself ("native"), never by a separately billed OCR engine.
      ...(fileDataUrl ? { plugins: [{ id: "file-parser", pdf: { engine: "native" } }] } : {}),
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema: jsonSchema },
      },
      // Real tokens and real dollar cost on the response, so the ai_calls row this call feeds
      // (lib/ai/call-ledger.ts) bills what OpenRouter actually charged, not an estimate.
      usage: { include: true },
      // The coach carries health data: route only to providers that neither store nor train on
      // prompts, and only to ones that honour response_format, so a reply is never free text.
      // 2026-10-02 DeepSeek audit (finding #5): `data_collection: "deny"` alone covers training,
      // not storage — `zdr` is OpenRouter's own storage-side Zero Data Retention switch, and the
      // owner's own data-handling commitment (docs/ai-data-handling.md) needs both. Live-tested OK
      // for anthropic/claude-haiku-4.5, google/gemini-2.5-flash and google/gemini-3-flash-preview.
      provider: { data_collection: "deny", zdr: true, require_parameters: true },
      // OD06: a caller watching the reply as it is written gets server-sent events instead.
      ...(onText ? { stream: true } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    // 2026-10-02 Grok audit: the body used to ride along (300 chars) in the thrown message, which
    // model-loop.ts's console.error then prints up to 500 chars of — but a 4xx body can echo the
    // rejected request back (a validation error quoting the prompt), and the coach's prompt can
    // carry health data. Only the status crosses into the message; the body is never read at all.
    throw new ProviderHttpError(response.status, `openrouter ${response.status}`);
  }
  if (onText) return readOpenRouterStream(response, onText);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    // Not the parser's message: it quotes the body, which carries the model's reply.
    throw new SchemaRejection("openrouter reply is not valid JSON");
  }
  const body = json as {
    choices?: { message?: { content?: string }; finish_reason?: string | null }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new SchemaRejection("openrouter reply has no message content");
  return {
    text: content,
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
    costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : 0,
    finishReason: finishReasonOf(body.choices?.[0]?.finish_reason),
  };
}

/** The provider's finish reason as a short code ("stop", "length"), or null when it sent none. */
function finishReasonOf(value: unknown): string | null {
  return typeof value === "string" && /^[a-z_]{1,32}$/i.test(value) ? value : null;
}

type StreamChunk = {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { code?: number | string };
};

/**
 * OD06 / W091: one streamed chat completion, read to its end. OpenRouter sends server-sent events:
 * `data: {chunk}` lines, `: comment` keep-alives, and `data: [DONE]`. Each chunk's delta is
 * appended and `onText` sees the whole text so far; the usage (tokens and billed cost) rides on
 * the last chunk. A provider error after the headers arrives as a chunk carrying `error`, and is
 * thrown as the same ProviderHttpError a non-2xx would be (only its code crosses, never its body).
 * A stream that ends without its usage chunk or `[DONE]` is a cut-off reply, thrown as a
 * retryable 502 even when its JSON looks whole: its tokens and cost are unknown, and a reply that
 * billed 0 would let the spend caps under-count. `onText("")` opens each attempt, so a retry
 * clears what the failed attempt showed.
 */
export async function readOpenRouterStream(
  response: Response, onText: (raw: string) => void,
): Promise<OpenRouterResult> {
  if (!response.body) throw new SchemaRejection("openrouter stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";
  let usage: StreamChunk["usage"];
  let finishReason: string | null = null;
  let ended = false;
  const watch = (soFar: string) => { try { onText(soFar); } catch { /* never fails the call */ } };
  watch("");
  const take = (line: string): boolean => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { ended = true; return true; }
    let chunk: StreamChunk;
    try { chunk = JSON.parse(data) as StreamChunk; } catch { return false; }
    if (chunk.error) {
      const code = Number(chunk.error.code);
      const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : 502;
      throw new ProviderHttpError(status, `openrouter ${status}`);
    }
    finishReason = finishReasonOf(chunk.choices?.[0]?.finish_reason) ?? finishReason;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta !== "") {
      text += delta;
      watch(text);
    }
    if (chunk.usage) { usage = chunk.usage; ended = true; }
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = done ? "" : lines.pop() ?? "";
      for (const line of lines) if (take(line)) return finished();
      if (done) return finished();
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  function finished(): OpenRouterResult {
    if (!ended) throw new ProviderHttpError(502, "openrouter 502");
    return {
      text,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      costUsd: typeof usage?.cost === "number" ? usage.cost : 0,
      finishReason,
    };
  }
}

export type OpenRouterArgs<T> = {
  payload: OpenRouterPayload;
  userId: string;
  admin: SupabaseClient;
  /** The OpenRouter catalog slug to call, e.g. "google/gemini-2.5-flash" — never a literal this
   *  file pins (see the module comment). */
  modelId: string;
  schema: ZodType<T>;
  /** The schema sent to the PROVIDER, when it must differ from the one the reply is parsed with
   *  (lib/coach/turn.ts turnStepProviderSchema — every key required, mirroring the Gemini path). */
  providerSchema?: ZodType;
  temperature?: number;
  /** The same output ceiling the Gemini path sends; without it a runaway reply bills unbounded. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  /**
   * 2026-10-02 Grok audit: mirrors lib/ai/adapter.ts's own `abandonOnCapacity` — true for the
   * coach's PRIMARY OpenRouter model, which has a fallback (another OpenRouter model, or Gemini)
   * waiting, so its first capacity failure (429/503) is abandoned at once rather than spending
   * RETRIES's second attempt on a model already known to be out of capacity.
   */
  abandonOnCapacity?: boolean;
  /** Asked before each retry; false stops the call (lib/ai/call.ts RetryPolicy.beforeRetry). */
  beforeRetry?: () => Promise<boolean>;
  /**
   * The `ai_calls.input_hash` to record instead of this transport's own text+image hash. Capture
   * (lib/ai/capture.ts) passes its Gemini twin's hash so the propose route's ten-minute duplicate
   * probe (lib/server/capture.ts) finds the same request whichever provider answered it.
   */
  inputHash?: string;
  /**
   * OD06 / W091: stream the reply and show it the raw text so far, chunk by chunk, on every
   * attempt (a retry starts again from ""). The reply is still parsed and judged whole, once.
   */
  onText?: (raw: string) => void;
} & RefuseArg<T>;

export type OpenRouterDeps = {
  send?: typeof callOpenRouter;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * A free-form field (a tool call's `args`, which lowers to `{}`) as the provider sees it.
 *
 * Claude refuses an empty sub-schema ("Empty schema ({}) that accepts any JSON value is not
 * supported", live 2026-10-02), and the first fix — a bare `{ type: "object" }` — was worse: under
 * `strict: true` an object with no listed properties may hold NO properties, so every tool call
 * arrived as `args: {}` (live 2026-10-02: suggest_options refused three times in a row with
 * "kind: Invalid option", and the turn ended "I'm sorry, I cannot fulfill that request").
 * Gemini through OpenRouter also rejects `additionalProperties: true`. So a free-form field goes
 * out as a JSON string the model writes the object into, and `decodeFreeForm` turns it back into
 * the object before the reply is parsed. The tool's own input schema still checks it after that.
 */
const FREE_FORM_STRING = {
  type: "string",
  description: "A JSON object written as a string, for example {\"kind\":\"snack\",\"count\":3}. Use {} for none.",
};

/** The provider schema, plus the paths of every free-form field ("*" stands for an array item). */
function openFreeForm(node: unknown, path: string[] = [], found: string[][] = []):
  { schema: unknown; freeForm: string[][] } {
  const walk = (value: unknown, at: string[]): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, at));
    if (!value || typeof value !== "object") return value;
    if (Object.keys(value).length === 0) { found.push(at); return FREE_FORM_STRING; }
    return Object.fromEntries(Object.entries(value).map(([key, sub]) => {
      // A keyword's own value (an enum list, `required`) is data, not a sub-schema; `properties`
      // and `$defs` are maps OF sub-schemas, so their entries are walked, not the map itself.
      if (key === "enum" || key === "required" || key === "const") return [key, sub];
      if ((key === "properties" || key === "$defs" || key === "definitions") && sub
        && typeof sub === "object" && !Array.isArray(sub)) {
        return [key, Object.fromEntries(Object.entries(sub).map(([name, child]) =>
          [name, walk(child, key === "properties" ? [...at, name] : at)]))];
      }
      if (key === "items") return [key, walk(sub, [...at, "*"])];
      return [key, walk(sub, at)];
    }));
  };
  return { schema: walk(node, path), freeForm: found };
}

/**
 * One free-form string back to its value. Live 2026-10-03: a call still arrived as a string the
 * strict parse refused (`expected object, received string`), intermittently. Accepts only a plain
 * JSON object, or one that was itself JSON-encoded once more. An empty string stays `{}` (the
 * decoder's contract before 2026-10-03). Prose around braces, arrays, null, numbers and booleans
 * all stay the original string, so the tool's own schema refuses them by name and the turn retries:
 * a brace scrape could turn an explanation or an echoed schema example into the call that runs.
 */
export function parseLooseObject(text: string): unknown {
  const attempt = (raw: string): unknown => {
    try { return JSON.parse(raw); } catch { return undefined; }
  };
  const trimmed = text.trim();
  if (trimmed === "") return {};
  let value = attempt(trimmed);
  if (typeof value === "string") value = attempt(value.trim());
  const plainObject = value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
  return plainObject ? value : text;
}

/** Turns each free-form field the model wrote as a JSON string back into its value. */
export function decodeFreeForm(value: unknown, paths: readonly string[][]): unknown {
  const decode = (node: unknown, rest: readonly string[]): unknown => {
    if (rest.length === 0) return typeof node === "string" ? parseLooseObject(node) : node;
    const [head, ...tail] = rest;
    if (head === "*") return Array.isArray(node) ? node.map((item) => decode(item, tail)) : node;
    if (!node || typeof node !== "object" || Array.isArray(node) || !(head in node)) return node;
    return { ...(node as Record<string, unknown>), [head]: decode((node as Record<string, unknown>)[head], tail) };
  };
  return paths.reduce((current, path) => decode(current, path), value);
}

/**
 * The OpenRouter lane: builds the request from a `coachOpenRouterPayload` (lib/ai/openrouter-payloads.ts),
 * runs it through callModel (gates, retries, the one `ai_calls` row — provider "openrouter"), and
 * parses the reply against the same schema the Gemini path uses, so a turn step looks identical to
 * the coach loop whichever provider answered it.
 */
export async function generateOpenRouter<T>(
  args: OpenRouterArgs<T>, deps: OpenRouterDeps = {},
): Promise<T> {
  const { schema: jsonSchema, freeForm } = openFreeForm(toPlainJsonSchema(args.providerSchema ?? args.schema));
  return callModel({
    payload: args.payload,
    provenance: openRouterProvenance,
    target: () => ({ provider: "openrouter", model: args.modelId, sdkVersion: SDK_VERSION }),
    // A missing key refuses before the circuit and spend-cap reads, same as the transport's own
    // check would a moment later — callers are expected to gate on provider-env.ts's
    // openRouterConfigured() first, this is a backstop, not the primary guard.
    admit: () => {
      if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
    },
    ledger: () => ({ userId: args.userId, admin: args.admin }),
    // ai_calls.input_hash is bytea (hex literal), same convention as lib/ai/adapter.ts inputHashFor.
    inputHash: () => args.inputHash ?? `\\x${createHash("sha256").update(args.payload.text)
      .update(args.payload.imageDataUrl ?? "").update(args.payload.fileDataUrl ?? "")
      .update(args.payload.audioDataUrl ?? "").digest("hex")}`,
    policy: {
      attempts: RETRIES + 1,
      budgetMs: args.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      attemptMs: args.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
      backoffMs: BACKOFF_MS,
      // Only a 429/503 is ever retried, and both are capacity failures, so abandoning on capacity
      // is simply never retrying one of them. Nothing else is retried: a SchemaRejection, and in
      // particular an UnusableReply (an unreadable label), is final — exactly as generateStructured
      // treats it — so it is billed once and never re-sampled into an invented answer.
      retryable: (e) => !isFinalReply(e) && !args.abandonOnCapacity
        && e instanceof ProviderHttpError && RETRYABLE_STATUSES.has(e.status),
      beforeRetry: args.beforeRetry,
      sleep: deps.sleep,
    },
    transport: {
      send: (signal, model) => (deps.send ?? callOpenRouter)(
        model, args.payload.text, jsonSchema, args.temperature ?? 0, signal, args.maxOutputTokens,
        args.payload.imageDataUrl, args.payload.purpose === "coach-openrouter"
          ? "coach_turn_step" : args.payload.purpose.replace(/[^a-zA-Z0-9_-]/g, "_"),
        args.payload.fileDataUrl, args.payload.audioDataUrl, args.onText),
    },
    accept: (result) => {
      // W087: a refusal names the finish reason, so a reply the output cap cut off reads apart
      // from one the model wrote whole in the wrong shape.
      const finish = result.finishReason ? ` (finish: ${result.finishReason})` : "";
      let decoded: unknown;
      try {
        decoded = decodeFreeForm(parseModelJson(stripJsonFence(result.text)), freeForm);
      } catch (e) {
        if (e instanceof SchemaRejection) throw new SchemaRejection(`${e.message}${finish}`);
        throw e;
      }
      const parsed = args.schema.safeParse(decoded);
      if (!parsed.success) {
        throw new SchemaRejection(
          `model output failed the schema: ${schemaIssueSummary(parsed.error)}${finish}`);
      }
      return acceptRefused(parsed.data, args.refuse);
    },
    // The real cost comes from the provider's own usage.cost (surchargeUsd), never a local
    // estimate: an arbitrary catalog model's per-token price is not this app's to track.
    price: () => 0,
    // No price table for OpenRouter's catalog: the configured per-attempt allowance (lib/ai/spend.ts).
    maxAttemptCostUsd: () => openRouterAttemptCeilingUsd(),
    surchargeUsd: (result) => openRouterAttemptCost(result.costUsd),
  });
}
