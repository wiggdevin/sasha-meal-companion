/**
 * Phase 13 §2 and §9 R3 (slice 0): the Gemini payload builders. Each one checks the project
 * attestation (lib/ai/attestation.ts) FIRST, before it serialises anything, so with the attestation
 * off no user text, audio or photo is ever turned into a request. lib/ai/adapter.ts checks it again
 * before a media upload.
 */
import type { Part } from "@google/genai";
import { assertGeminiAttested } from "@/lib/ai/attestation";
import { deepFreeze } from "@/lib/ai/freeze";
import { DOCUMENT_PROMPT, documentTextBlock } from "@/lib/ai/document";
import { inspirePhotoPrompt } from "@/lib/ai/inspire";
import {
  ONBOARDING_EXTRACT_SYSTEM, onboardingExtractUserText,
} from "@/lib/ai/onboarding-extract-prompt";
import type { GeminiPayload, GeminiPurpose, Media } from "@/lib/ai/payloads";
import type { DocumentPayloadInput } from "@/lib/ai/openrouter-payloads";
import { PROMPTS, TRANSCRIBE_PROMPT, userPayload } from "@/lib/ai/prompts";
import type { CapturePurpose } from "@/lib/ai/schemas";
import { MAX_DOCUMENT_TEXT, sniffBytes } from "@/lib/plan/document-files";

/** The purpose each Gemini payload was minted for. Private: only this module's builders write it. */
const provenance = new WeakMap<object, GeminiPurpose>();

/**
 * Mints a frozen payload. Media bytes cannot be frozen, so the builder keeps its own copy in a
 * closure and `media.bytes` returns a fresh copy of it on every read: whatever a caller does to a
 * copy it read, the bytes that are uploaded or sent are the ones the builder was given.
 */
function gemini<P extends GeminiPurpose>(
  purpose: P, parts: readonly Part[], media?: Media,
): GeminiPayload<P> {
  const stored = media ? new Uint8Array(media.bytes) : null;
  const payload = deepFreeze({
    purpose,
    parts: parts.map((part) => ({ ...(part.text === undefined ? {} : { text: String(part.text) }) })),
    ...(media && stored ? { media: {
      mimeType: String(media.mimeType),
      get bytes() { return new Uint8Array(stored); },
    } } : {}),
  });
  provenance.set(payload, purpose);
  return payload as unknown as GeminiPayload<P>;
}

/** The purpose a Gemini builder minted this value for, or null for anything else. */
export function geminiProvenance(value: unknown): GeminiPurpose | null {
  return typeof value === "object" && value !== null ? provenance.get(value) ?? null : null;
}

/** `coach` (D2): the turn transcript, in order. Checks the attestation before joining it. */
export function coachTurnPayload(transcript: readonly string[]): GeminiPayload<"coach"> {
  assertGeminiAttested();
  return gemini("coach", [{ text: transcript.join("\n\n") }]);
}

/** `weeklyReview` (D1): the week's totals prompt. */
export function weeklyReviewPayload(prompt: string): GeminiPayload<"weeklyReview"> {
  assertGeminiAttested();
  return gemini("weeklyReview", [{ text: prompt }]);
}

/** `coach-transcribe` (D2): the fixed transcription prompt and the user's audio clip. */
export function transcribePayload(media: Media): GeminiPayload<"coach-transcribe"> {
  assertGeminiAttested();
  return gemini("coach-transcribe", [{ text: TRANSCRIBE_PROMPT }], media);
}

/** The Plan photo's Gemini twin has the same fixed question and one validated image. */
export function inspirePhotoGeminiPayload(media: Media,
  read: Parameters<typeof inspirePhotoPrompt>[0] = {}): GeminiPayload<"photoToIdeas-gemini"> {
  assertGeminiAttested();
  if (!/^image\/(jpeg|png)$/.test(media.mimeType)) throw new Error("refused: photoToIdeas takes a JPEG or PNG");
  return gemini("photoToIdeas-gemini", [{ text: inspirePhotoPrompt(read) }], media);
}

/** The Plan document's Gemini twin preserves the OpenRouter builder's bounds and text fence. */
export function documentPlanGeminiPayload(doc: DocumentPayloadInput): GeminiPayload<"documentToPlan-gemini"> {
  assertGeminiAttested();
  if (doc.kind === "text") {
    const text = doc.text.slice(0, MAX_DOCUMENT_TEXT);
    if (!text.trim()) throw new Error("refused: documentToPlan takes non-empty text");
    return gemini("documentToPlan-gemini", [{ text: `${DOCUMENT_PROMPT}\n\n${documentTextBlock(text)}` }]);
  }
  const mimeType = sniffBytes(doc.bytes);
  if (doc.kind === "pdf" && mimeType !== "application/pdf") throw new Error("refused: documentToPlan takes a PDF here");
  if (doc.kind === "image" && mimeType !== "image/jpeg" && mimeType !== "image/png") {
    throw new Error("refused: documentToPlan takes a JPEG or PNG photo");
  }
  if (mimeType === null) throw new Error("refused: documentToPlan takes a supported file");
  return gemini("documentToPlan-gemini", [{ text: DOCUMENT_PROMPT }],
    { bytes: doc.bytes, mimeType });
}

/**
 * `lookup` (§3.3, slice 6): a single, fixed question template plus the validated, catalog-resolved
 * subject — never the caller's raw text. The template is a separate part, not interpolated into
 * one string, so the payload literally carries nothing the subject validator and resolver did not
 * already clear (§9 R8).
 */
export const LOOKUP_QUESTION_TEMPLATE =
  "Using web search, answer briefly and in plain prose about the following food, dish, brand or "
  + "restaurant item: what it commonly is, and any commonly reported allergens or dietary flags. "
  + "State a nutrition number only when a specific search result supports it; otherwise leave it "
  + "out. Do not guess, and do not address or describe any person.";

export function lookupPayload(subject: string): GeminiPayload<"lookup"> {
  assertGeminiAttested();
  return gemini("lookup", [{ text: LOOKUP_QUESTION_TEMPLATE }, { text: subject }]);
}

/**
 * `onboarding-extract` (D1): the fixed onboarding prompt and the user's opener text, wrapped as
 * untrusted data (lib/ai/onboarding-extract-prompt.ts). The caller
 * (lib/server/onboarding-extract.ts) is responsible for never calling this builder with text the
 * local safety guard has not already cleared, and for always passing already-redacted text
 * (lib/coach/onboarding-fast-path.ts `redactAgeAndSex`) — the standing privacy rule
 * (tests/ai/no-demographics-payload.test.ts) depends on that, not on this builder, which carries
 * no filter of its own and only shapes the request.
 */
export function onboardingExtractPayload(text: string): GeminiPayload<"onboarding-extract"> {
  assertGeminiAttested();
  return gemini("onboarding-extract", [
    { text: ONBOARDING_EXTRACT_SYSTEM },
    { text: onboardingExtractUserText(text) },
  ]);
}

/** Fields every capture purpose's input shares. */
export type CaptureCommon = { slot?: string; localDate: string };
/** `textToItems`'s own input: the user's typed description is the only purpose that gets free text. */
export type TextCaptureInput = CaptureCommon & { text: string };
/**
 * The three media purposes' own input: no `text` field at all — the photo, the label photo or the
 * audio clip is the only content a caller can put in front of the model. There is no `note` field
 * either, for any purpose: the wire (`ProposeRequest`, lib/capture/types.ts) carries `text` for the
 * text method and `mediaPath` for the other three, never a free-standing note, so a `note` channel
 * would be dead code carrying nothing but a way to smuggle text into a media purpose's request
 * (review round 1, sol lens BLOCK on gemini-payloads.ts:61).
 */
export type MediaCaptureInput = CaptureCommon;
/** @deprecated kept only for older imports; use TextCaptureInput or MediaCaptureInput. */
export type CaptureText = TextCaptureInput | MediaCaptureInput;

/** The three capture purposes whose payload carries the media the user submitted. */
type MediaCapturePurpose = Exclude<CapturePurpose, "textToItems"> & GeminiPurpose;

/**
 * The four capture purposes: the purpose's system prompt, the user half, and any media.
 *
 * Phase 13 §9 R3: media is required for photoToItems, voiceToItems and labelToNutrients, and
 * disallowed for textToItems — a purpose's payload cannot silently carry the wrong shape. Each
 * purpose also gets its OWN input type (TextCaptureInput vs MediaCaptureInput): a literal-purpose
 * call to a media purpose cannot type-check a `text` property onto its input, and a literal
 * `"textToItems"` call cannot type-check a missing one. A caller that reaches capturePayload
 * through a variable purpose (lib/server/capture.ts, whose purpose comes from `PURPOSE_BY_METHOD`)
 * still needs a third, permissive overload — but naming it `P extends CapturePurpose` (Sol r2
 * finding 2, FIX) let TS infer `P` from a LITERAL call too, and its overload resolution falls
 * through to that permissive signature whenever a literal call's input doesn't fit the strict
 * overload above it (an object literal with an extra `text` property is excess-property-checked
 * out of the MediaCaptureInput-only first overload, but the permissive overload's
 * `TextCaptureInput | MediaCaptureInput` union input has no excess-property problem, since `text`
 * is a known key somewhere in that union) — so a literal purpose type-checked with the wrong input
 * shape after all. `OnlyUnionPurpose` closes that: `IsUnion` (the standard naked-type-param
 * distribution trick) is true only when `P` has more than one member, so a single-literal call
 * (`capturePayload("photoToItems", …)`) infers `P` as one member, gets `never` here, and is forced
 * onto the strict overloads above, where excess-property checking does its job. A caller whose
 * purpose is genuinely variable — lib/server/capture.ts's full `CapturePurpose`, or a narrower
 * multi-member union like a test helper's `"textToItems" | "photoToItems"` — still resolves `P`
 * unchanged, because its actual shape can only be checked at runtime: the check below still
 * forwards `text` only when the purpose IS textToItems, as the last line of defence for whatever a
 * multi-purpose caller (or an outright cast) can still send past every overload (review round 1,
 * sol lens BLOCK on gemini-payloads.ts:61).
 */
/** True when `T` is a union of more than one member; false for a single literal. */
type IsUnion<T, U = T> = T extends U ? ([U] extends [T] ? false : true) : never;
/** `P` unchanged when it is a multi-member union; `never` for a single literal. */
type OnlyUnionPurpose<P> = IsUnion<P> extends true ? P : never;
export function capturePayload<P extends MediaCapturePurpose>(
  purpose: P, input: MediaCaptureInput, media: Media,
): GeminiPayload<P>;
export function capturePayload(
  purpose: "textToItems", input: TextCaptureInput, media?: undefined,
): GeminiPayload<"textToItems">;
export function capturePayload<P extends CapturePurpose & GeminiPurpose>(
  purpose: OnlyUnionPurpose<P>,
  input: TextCaptureInput | MediaCaptureInput, media: Media | undefined,
): GeminiPayload<P>;
export function capturePayload<P extends CapturePurpose & GeminiPurpose>(
  purpose: P, input: TextCaptureInput | MediaCaptureInput, media?: Media,
): GeminiPayload<P> {
  assertGeminiAttested();
  if (purpose === "textToItems") {
    if (media) throw new Error(`refused: capturePayload('${purpose}') takes no media`);
  } else if (!media) {
    throw new Error(`refused: capturePayload('${purpose}') requires media`);
  }
  // Only textToItems ever sends text, decided by the purpose itself, not by whatever properties
  // happen to be on `input` — so a caller that defeats the type system and hands a media purpose
  // a `text` (or `note`) property still never has it reach the request.
  const text = purpose === "textToItems" ? (input as TextCaptureInput).text : undefined;
  return gemini(purpose, [
    { text: PROMPTS[purpose].system },
    { text: userPayload({ text, slot: input.slot, localDate: input.localDate }) },
  ], media);
}
