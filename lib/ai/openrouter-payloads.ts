/**
 * Owner request 2026-10-02: "can we use open router? ... wire up my api key". The OpenRouter
 * payload builder, mirroring lib/ai/gemini-payloads.ts's shape — a frozen, branded
 * value a private WeakMap remembers minting, so callModel (lib/ai/call.ts) can refuse anything
 * else claiming to be one. Checks the OpenRouter attestation FIRST, before anything is
 * serialised: same D2 rule as Gemini's (lib/ai/attestation.ts), OpenRouter carries user content
 * only when OPENROUTER_ATTESTED=1, and D0 is exempt (not used here — the coach is always D2).
 */
import { assertOpenRouterAttested } from "@/lib/ai/attestation";
import type { PurposeOf } from "@/lib/ai/call-registry";
import { deepFreeze } from "@/lib/ai/freeze";
import type { MediaCaptureInput, TextCaptureInput } from "@/lib/ai/gemini-payloads";
import { DOCUMENT_PROMPT, documentTextBlock } from "@/lib/ai/document";
import { inspirePhotoPrompt } from "@/lib/ai/inspire";
import { MAX_DOCUMENT_TEXT, sniffBytes } from "@/lib/plan/document-files";
import { PROMPTS, TRANSCRIBE_PROMPT, userPayload } from "@/lib/ai/prompts";
import {
  ONBOARDING_EXTRACT_SYSTEM, onboardingExtractUserText,
} from "@/lib/ai/onboarding-extract-prompt";
import { ACCEPTED_AUDIO_TYPES } from "@/lib/media/validate";

declare const OPENROUTER_BRAND: unique symbol;

export type OpenRouterPurpose = PurposeOf<"openrouter">;

/** Builder output for OpenRouter (lib/ai/openrouter.ts): the prompt text and, for a vision
 *  purpose, one image as a data URL, or for a document purpose one PDF as a data URL. Nothing else
 *  reaches the provider. */
export type OpenRouterPayload<P extends OpenRouterPurpose = OpenRouterPurpose> = {
  readonly [OPENROUTER_BRAND]: P;
  readonly purpose: P;
  readonly text: string;
  readonly imageDataUrl?: string;
  readonly fileDataUrl?: string;
  /** 2026-10-06: one clip as a data URL (`data:audio/<type>;base64,...`), for the voice capture
   *  and transcribe twins — lib/ai/openrouter.ts turns it into an `input_audio` content part. */
  readonly audioDataUrl?: string;
};

/** The purpose each OpenRouter builder minted this value for. Private: only this module writes it. */
const provenance = new WeakMap<object, OpenRouterPurpose>();

function openrouter<P extends OpenRouterPurpose>(
  purpose: P, text: string, imageDataUrl?: string, fileDataUrl?: string, audioDataUrl?: string,
): OpenRouterPayload<P> {
  const payload = deepFreeze({ purpose, text, ...(imageDataUrl ? { imageDataUrl } : {}),
    ...(fileDataUrl ? { fileDataUrl } : {}), ...(audioDataUrl ? { audioDataUrl } : {}) });
  provenance.set(payload, purpose);
  return payload as unknown as OpenRouterPayload<P>;
}

/** The purpose an OpenRouter builder minted this value for, or null for anything else. */
export function openRouterProvenance(value: unknown): OpenRouterPurpose | null {
  return typeof value === "object" && value !== null ? provenance.get(value) ?? null : null;
}

/**
 * `coach-openrouter` (D2): the same turn transcript the Gemini `coach` purpose sends
 * (lib/ai/gemini-payloads.ts coachTurnPayload), going instead to the owner's chosen OpenRouter
 * model — the pinned capacity fallback or the primary
 * (COACH_PROVIDER=openrouter). A separate purpose, not a shared one, so callRefusal's provider
 * check still refuses a payload minted for `coach` if it ever reached the OpenRouter transport.
 */
export function coachOpenRouterPayload(transcript: readonly string[]): OpenRouterPayload<"coach-openrouter"> {
  assertOpenRouterAttested();
  return openrouter("coach-openrouter", transcript.join("\n\n"));
}

/**
 * `photoToIdeas` (D1): the plan sheet's fixed photo prompt and the user's one JPEG or PNG. Owner
 * request 2026-10-02: Gemini-family calls go through OpenRouter. No caller text reaches it.
 */
export function inspirePhotoPayload(media: { bytes: Uint8Array; mimeType: string },
  read: Parameters<typeof inspirePhotoPrompt>[0] = {}): OpenRouterPayload<"photoToIdeas"> {
  assertOpenRouterAttested();
  if (!/^image\/(jpeg|png)$/.test(media.mimeType)) throw new Error("refused: photoToIdeas takes a JPEG or PNG");
  const url = `data:${media.mimeType};base64,${Buffer.from(media.bytes).toString("base64")}`;
  return openrouter("photoToIdeas", inspirePhotoPrompt(read), url);
}

/** One document from the Plan panel's "+": its bytes (already sniffed and size-checked) or its text. */
export type DocumentPayloadInput =
  | { kind: "image"; bytes: Uint8Array }
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "text"; text: string };

/**
 * `documentToPlan` (D2): the fixed document prompt plus the person's one file — a JPEG or PNG as an
 * image part, a PDF as a file part, or plain text fenced as data inside the prompt
 * (lib/ai/document.ts documentTextBlock). The type is read from the bytes, never from a claim.
 */
export function documentPlanPayload(doc: DocumentPayloadInput): OpenRouterPayload<"documentToPlan"> {
  assertOpenRouterAttested();
  if (doc.kind === "text") {
    const text = doc.text.slice(0, MAX_DOCUMENT_TEXT);
    if (!text.trim()) throw new Error("refused: documentToPlan takes non-empty text");
    return openrouter("documentToPlan", `${DOCUMENT_PROMPT}\n\n${documentTextBlock(text)}`);
  }
  const sniffed = sniffBytes(doc.bytes);
  const base64 = () => Buffer.from(doc.bytes).toString("base64");
  if (doc.kind === "pdf") {
    if (sniffed !== "application/pdf") throw new Error("refused: documentToPlan takes a PDF here");
    return openrouter("documentToPlan", DOCUMENT_PROMPT, undefined, `data:application/pdf;base64,${base64()}`);
  }
  if (sniffed !== "image/jpeg" && sniffed !== "image/png") {
    throw new Error("refused: documentToPlan takes a JPEG or PNG photo");
  }
  return openrouter("documentToPlan", DOCUMENT_PROMPT, `data:${sniffed};base64,${base64()}`);
}

/**
 * `onboarding-extract-openrouter` (D1): the OpenRouter twin of `onboardingExtractPayload`
 * (lib/ai/gemini-payloads.ts) — same fixed prompt, same already-redacted text (the caller's
 * job, not this builder's — see that function's doc comment and the standing privacy rule,
 * tests/ai/no-demographics-payload.test.ts), asked first (lib/server/onboarding-extract.ts),
 * with the Gemini purpose as its fallback leg. Separate purpose, not a shared one, so
 * callRefusal's provider check still refuses a payload minted for one purpose reaching the
 * other transport.
 */
export function onboardingExtractOpenRouterPayload(
  text: string,
): OpenRouterPayload<"onboarding-extract-openrouter"> {
  assertOpenRouterAttested();
  return openrouter(
    "onboarding-extract-openrouter",
    `${ONBOARDING_EXTRACT_SYSTEM}\n\n${onboardingExtractUserText(text)}`,
  );
}

/**
 * The capture purposes OpenRouter can answer (lib/ai/capture.ts). `voiceToItems-openrouter`
 * (2026-10-06, the Gemini outage) is Gemini's same-key fallback having no point left: a 403
 * PERMISSION_DENIED blocks every model on that key, so a clip needs a different provider, not a
 * different Gemini model.
 */
export type CaptureOpenRouterPurpose =
  | "textToItems-openrouter" | "photoToItems-openrouter" | "labelToNutrients-openrouter"
  | "voiceToItems-openrouter";
/** The Gemini capture purpose each OpenRouter twin mirrors: same prompt, schema and data class. */
export const CAPTURE_TWIN = {
  "textToItems-openrouter": "textToItems",
  "photoToItems-openrouter": "photoToItems",
  "labelToNutrients-openrouter": "labelToNutrients",
  "voiceToItems-openrouter": "voiceToItems",
} as const satisfies Record<CaptureOpenRouterPurpose, string>;

/** The OpenRouter twin of a Gemini capture purpose, or null when it has none. */
export function openRouterCapturePurpose(purpose: string): CaptureOpenRouterPurpose | null {
  const hit = Object.entries(CAPTURE_TWIN).find(([, twin]) => twin === purpose);
  return hit ? hit[0] as CaptureOpenRouterPurpose : null;
}

type CaptureMedia = { bytes: Uint8Array; mimeType: string };

/**
 * `textToItems-openrouter` (D2), `photoToItems-openrouter`, `labelToNutrients-openrouter` (D1) and
 * `voiceToItems-openrouter` (D2, 2026-10-06): the SAME system prompt and data envelope the Gemini
 * twin sends (lib/ai/gemini-payloads.ts capturePayload), joined into one user message, plus — for
 * the photo/label purposes, the user's one JPEG or PNG, and for voice, their one clip — as a data
 * URL. The media was already fetched and re-validated (lib/media/validate.ts validateImage /
 * validateAudio: type sniffed, size capped) before this runs. Only the text purpose carries the
 * caller's text, decided by the purpose, not by `input`.
 */
export function captureOpenRouterPayload(
  purpose: "textToItems-openrouter", input: TextCaptureInput, media?: undefined,
): OpenRouterPayload<"textToItems-openrouter">;
export function captureOpenRouterPayload<P extends "photoToItems-openrouter" | "labelToNutrients-openrouter" | "voiceToItems-openrouter">(
  purpose: P, input: MediaCaptureInput, media: CaptureMedia,
): OpenRouterPayload<P>;
export function captureOpenRouterPayload(
  purpose: CaptureOpenRouterPurpose, input: TextCaptureInput | MediaCaptureInput, media?: CaptureMedia,
): OpenRouterPayload<CaptureOpenRouterPurpose>;
export function captureOpenRouterPayload(
  purpose: CaptureOpenRouterPurpose, input: TextCaptureInput | MediaCaptureInput, media?: CaptureMedia,
): OpenRouterPayload<CaptureOpenRouterPurpose> {
  assertOpenRouterAttested();
  const twin = Object.hasOwn(CAPTURE_TWIN, purpose) ? CAPTURE_TWIN[purpose] : undefined;
  if (!twin) throw new Error(`refused: '${String(purpose)}' is not an OpenRouter capture purpose`);
  const isAudio = twin === "voiceToItems";
  if (twin === "textToItems") {
    if (media) throw new Error(`refused: captureOpenRouterPayload('${purpose}') takes no media`);
  } else if (isAudio) {
    if (!media) throw new Error(`refused: captureOpenRouterPayload('${purpose}') requires media`);
    if (!ACCEPTED_AUDIO_TYPES.includes(media.mimeType)) {
      throw new Error(`refused: ${purpose} takes ${ACCEPTED_AUDIO_TYPES.join(", ")}`);
    }
  } else {
    if (!media) throw new Error(`refused: captureOpenRouterPayload('${purpose}') requires media`);
    if (!/^image\/(jpeg|png)$/.test(media.mimeType)) {
      throw new Error(`refused: ${purpose} takes a JPEG or PNG`);
    }
  }
  const text = twin === "textToItems" ? (input as TextCaptureInput).text : undefined;
  const prompt = [
    PROMPTS[twin].system,
    userPayload({ text, slot: input.slot, localDate: input.localDate }),
  ].join("\n\n");
  const url = media
    ? `data:${media.mimeType};base64,${Buffer.from(media.bytes).toString("base64")}` : undefined;
  return isAudio ? openrouter(purpose, prompt, undefined, undefined, url) : openrouter(purpose, prompt, url);
}

/**
 * `coach-transcribe-openrouter` (D2, 2026-10-06): the SAME fixed transcription prompt the Gemini
 * twin sends (lib/ai/gemini-payloads.ts transcribePayload) plus the user's one clip as a data URL.
 * The clip was already fetched and re-validated (lib/media/validate.ts validateAudio) before this
 * runs — same contract as every other capture twin above.
 */
export function transcribeOpenRouterPayload(
  media: CaptureMedia,
): OpenRouterPayload<"coach-transcribe-openrouter"> {
  assertOpenRouterAttested();
  if (!ACCEPTED_AUDIO_TYPES.includes(media.mimeType)) {
    throw new Error(`refused: coach-transcribe-openrouter takes ${ACCEPTED_AUDIO_TYPES.join(", ")}`);
  }
  const url = `data:${media.mimeType};base64,${Buffer.from(media.bytes).toString("base64")}`;
  return openrouter("coach-transcribe-openrouter", TRANSCRIBE_PROMPT, undefined, undefined, url);
}
