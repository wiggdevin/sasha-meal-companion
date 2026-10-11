/**
 * The server half of the coach's voice fallback — T7 §2.
 *
 * Read the object the user just uploaded, re-validate the bytes (a declared content type is a claim),
 * send them to the pinned flash model with a transcription-only prompt, and answer the words.
 * A fast provider failure can use the capture lane's pinned Gemini backup model.
 *
 * 2026-10-06 (Gemini project denial, #gemini-fallback): when BOTH Gemini models fail and the
 * failure is worth a different provider (a 403 PERMISSION_DENIED, a timeout, an open circuit — see
 * lib/ai/provider-fallback.ts), the clip goes to OpenRouter's audio-capable model
 * (lib/ai/models.ts captureVoiceOpenRouterModel) as a last resort. Gemini stays PRIMARY: the app
 * recovers onto it on its own the moment Google restores access, and OpenRouter is skipped
 * entirely when its key or attestation are not in place (`openRouterTranscribeReady`).
 *
 * The transcript is NOT stored. It is returned to their phone and forgotten: each governed model
 * call leaves one `ai_calls` row with tokens, latency and a hash, never the words. That is why the
 * voice fallback does not auto-send: the words exist only in the textarea the user is looking at.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { classifyFailure, generateStructured, ProviderHttpError } from "@/lib/ai/adapter";
import { assertGeminiAttested, openRouterAttested } from "@/lib/ai/attestation";
import { isPermissionDeniedFailure, worthAnotherModel } from "@/lib/ai/failures";
import { transcribePayload } from "@/lib/ai/gemini-payloads";
import { LANES } from "@/lib/ai/lanes";
import { captureVoiceOpenRouterModel } from "@/lib/ai/models";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { transcribeOpenRouterPayload } from "@/lib/ai/openrouter-payloads";
import { providerFallbackWorthTrying } from "@/lib/ai/provider-fallback";
import { openRouterConfigured } from "@/lib/ai/provider-env";
import { MEDIA_PATH } from "@/lib/capture/types";
import { validateAudio } from "@/lib/media/validate";
import { HttpError } from "@/lib/server/auth";
import { fetchOwnedObject as fetchOwnedObjectImpl } from "@/lib/server/media";

/** Mirrors lib/ai/capture.ts captureOpenRouterReady(): OpenRouter answers only when its key and
 *  its own attestation are both in place. Read live so a running process sees an env change. */
export function openRouterTranscribeReady(): boolean {
  return openRouterConfigured() && openRouterAttested();
}

/** The `ai_calls.purpose` this call is recorded under, and its key in lib/ai/models.ts. */
export const TRANSCRIBE_PURPOSE = "coach-transcribe" as const;

/**
 * One budget for the primary and backup model calls together.
 *
 * It sits under the client's own 8 s `transcribe` deadline (lib/fetch-with-deadline.ts) with room
 * for the storage read either side, so the phone's copy ("Transcribing is slow right now") is the
 * LAST word on a slow call rather than a race with this one.
 *
 * The adapter's default is a 6 s attempt inside a longer budget, which is right for the short
 * structured calls it was measured on. Transcription is not one: measured against the live
 * provider on the local stack, an 11 s clip answers anywhere between 1.5 s and 7.5 s, so a 6 s
 * attempt cap threw away calls that were about to answer. The primary keeps the full 7 500 ms;
 * only a fast failure that leaves at least the adapter's 6 s attempt window uses the backup.
 */
export const TRANSCRIBE_CALL_MS = 7_500;
const TRANSCRIBE_BACKUP_MIN_MS = 6_000;

/** Enough for thirty seconds of speech and nothing like enough for a monologue about it. */
const MAX_OUTPUT_TOKENS = 1_024;

// The fixed prompt lives with the capture prompts; the payload builder owns it (§9 R3).
export { TRANSCRIBE_PROMPT } from "@/lib/ai/prompts";

const transcriptSchema = z.object({ text: z.string() });

/** The same media/<uid>/<uuid>.<ext> shape the sign route mints (W019, A136). */
export const transcribeRequestSchema = z.object({ path: z.string().max(512).regex(MEDIA_PATH) }).strip();
export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>;
export type TranscribeResponse = { text: string; ms: number };

export type TranscribeDeps = {
  fetchOwnedObject?: typeof fetchOwnedObjectImpl;
  generate?: typeof generateStructured;
  generateOpenRouter?: typeof generateOpenRouter;
};

/** The least OpenRouter needs to be worth asking, once both Gemini models have had their turn. */
const TRANSCRIBE_OPENROUTER_MIN_MS = 4_000;

/** §2's status table: a non-audio object is 415, a clip past the recorder's own ceiling is 422. */
function refuse(failure: { kind: "type" | "duration"; reason: string }): never {
  throw failure.kind === "duration"
    ? new HttpError(422, "too_long", failure.reason)
    : new HttpError(415, "unsupported_media", failure.reason);
}

export async function transcribeAudio(
  admin: SupabaseClient, userId: string, req: TranscribeRequest, deps: TranscribeDeps = {},
): Promise<TranscribeResponse> {
  // Phase 13 §9 R3: the attestation is checked before the clip is read, and again by the payload
  // builder before it is serialised. Off, transcription refuses with 503 nous_unconfirmed.
  assertGeminiAttested();
  // Throws 403 on any path that is not exactly one of theirs, before a byte is downloaded.
  const object = await (deps.fetchOwnedObject ?? fetchOwnedObjectImpl)(admin, userId, req.path);
  const checked = validateAudio(object.bytes, object.mimeType);
  if (!checked.ok) refuse(checked);

  const payload = transcribePayload({ bytes: object.bytes, mimeType: object.mimeType });
  const started = Date.now();
  /** 2026-10-06: the last resort once both Gemini models have failed. Null when OpenRouter is not
   *  configured/attested, the failure is not worth a different provider, or there is no time left
   *  — the caller then re-throws the Gemini error it already has, never this helper's own miss. */
  const tryOpenRouter = async (
    geminiError: unknown,
  ): Promise<z.infer<typeof transcriptSchema> | null> => {
    if (!openRouterTranscribeReady()) return null;
    if (!(isPermissionDeniedFailure(geminiError) || providerFallbackWorthTrying(geminiError))) return null;
    const left = TRANSCRIBE_CALL_MS - (Date.now() - started);
    if (left < TRANSCRIBE_OPENROUTER_MIN_MS) return null;
    const orPayload = transcribeOpenRouterPayload({ bytes: object.bytes, mimeType: object.mimeType });
    return (deps.generateOpenRouter ?? generateOpenRouter)({
      payload: orPayload, userId, admin, modelId: captureVoiceOpenRouterModel(),
      schema: transcriptSchema, maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: left, attemptTimeoutMs: left, abandonOnCapacity: true,
    });
  };
  try {
    const generate = deps.generate ?? generateStructured;
    const args = { payload, userId, admin, schema: transcriptSchema, maxOutputTokens: MAX_OUTPUT_TOKENS };
    const done = (out: z.infer<typeof transcriptSchema>): TranscribeResponse =>
      ({ text: out.text.trim(), ms: Date.now() - started });
    try {
      const out = await generate({ ...args, timeoutMs: TRANSCRIBE_CALL_MS,
        attemptTimeoutMs: TRANSCRIBE_CALL_MS, abandonOnCapacity: true });
      return done(out);
    } catch (e) {
      const left = TRANSCRIBE_CALL_MS - (Date.now() - started);
      const backup = LANES.capture.fallback;
      // 2026-10-06 (Sol review, BLOCK): the backup's own minimum (6 s) leaves almost nothing of
      // the 7.5 s total for a THIRD hop afterwards — giving it the whole remainder starved
      // OpenRouter on any failure slower than an instant 403. Once OpenRouter is configured and
      // attested it is worth more than a second SAME-KEY Gemini model (a project-wide denial
      // blocks both alike; capacity failures meet the same wall either way, lib/ai/failures.ts
      // worthAnotherModel), so the backup is skipped outright and the full remaining budget goes
      // to OpenRouter instead. Without OpenRouter ready, nothing here changes from before.
      const backupWorthIt = !openRouterTranscribeReady() && !isPermissionDeniedFailure(e)
        && providerFallbackWorthTrying(e) && (!(e instanceof ProviderHttpError) || worthAnotherModel(e));
      if (backupWorthIt && backup && left >= TRANSCRIBE_BACKUP_MIN_MS) {
        try {
          const out = await generate({ ...args, route: { provider: "google", modelId: backup },
            timeoutMs: left, attemptTimeoutMs: left, abandonOnCapacity: true });
          return done(out);
        } catch (e2) {
          const fromOpenRouter = await tryOpenRouter(e2);
          if (fromOpenRouter) return done(fromOpenRouter);
          throw e2;
        }
      }
      const fromOpenRouter = await tryOpenRouter(e);
      if (fromOpenRouter) return done(fromOpenRouter);
      throw e;
    }
  } catch (e) {
    // A spend cap or a rate limit is already the right answer with the right status; only a
    // provider failure has to be turned into one.
    if (e instanceof HttpError) throw e;
    throw classifyFailure(e) === "timeout"
      ? new HttpError(503, "timeout", "Transcribing did not answer in time.")
      : new HttpError(503, "provider", "Transcribing is unavailable right now.");
  }
}
