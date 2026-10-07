"use client";

/**
 * The coach's voice fallback on the phone — T7 §2.
 *
 * Used when `SpeechRecognition` is absent, or after one of the three §3 errors switched this
 * session to the server. The hold records with `MediaRecorder` exactly as `components/
 * VoiceCapture.tsx` does (same `pickAudioMimeType`, same 30 s ceiling, same mic-error
 * classification — its helpers, not a copy of them), then the clip goes through the capture
 * bucket's own sign/upload helper and on to `POST /api/coach/transcribe`.
 *
 * The transcript lands in the textarea and is NOT sent: server transcription is slower and less
 * certain than the on-device path, so the user reads it and taps Send.
 */

import { signAndUpload, UPLOAD_FAILED } from "@/lib/capture-client";
import { SLOW_COPY } from "@/lib/coach/dictation";
import { DEADLINES, isDeadline } from "@/lib/fetch-with-deadline";
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";

export const TRANSCRIBE_URL = "/api/coach/transcribe";

/** The microphone itself is lib/capture-mic.ts — the FAB opens the same one (T7 §6). */
export { MAX_RECORDING_SECONDS as MAX_SECONDS, openMicRecorder } from "@/lib/capture-mic";

export const UPLOAD_FAILED_COPY = UPLOAD_FAILED;
/** Every other refusal reads the same to them: the words did not come back, so type them. */
export const TRANSCRIBE_FAILED_COPY = "Transcribing did not work. Type it, or try again.";

export type TranscribeOutcome =
  | { ok: true; text: string; ms: number }
  | { ok: false; message: string };

/**
 * Sign, upload, transcribe. Model and server text is DATA: a refusal is mapped onto one of the
 * lines above and its own words are never echoed back to them.
 */
export async function transcribeClip(
  clip: Blob, opts: { fetchImpl?: typeof fetch } = {},
): Promise<TranscribeOutcome> {
  /*
   * ONE budget for the whole hop, not one per call. §4 measures "release → transcript in the box",
   * which is sign plus upload plus transcribe; three separate deadlines could each pass while the
   * thing the user is actually waiting for ran to eighteen seconds (panel round 1, MEDIUM 12). The
   * per-call deadlines stay underneath as a backstop; this is the one the user is told about.
   */
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race decides what THE USER is told; the controller stops the work. Without the abort the sign,
  // the upload and the model call all keep running — and keep being paid for — after the phone
  // has given up on them (panel round 1, MEDIUM 9).
  const giveUp = new AbortController();
  const slow = new Promise<TranscribeOutcome>((resolve) => {
    timer = setTimeout(() => {
      giveUp.abort();
      resolve({ ok: false, message: SLOW_COPY });
    }, DEADLINES.transcribe);
  });
  try {
    return await Promise.race([uploadAndTranscribe(clip, opts, giveUp.signal), slow]);
  } finally {
    clearTimeout(timer);
  }
}

async function uploadAndTranscribe(
  clip: Blob, opts: { fetchImpl?: typeof fetch }, signal: AbortSignal,
): Promise<TranscribeOutcome> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const h: AccountHandle = accountHandle();
  const uploaded = await signAndUpload("audio", clip, fetchFn, { signal, account: h });
  if (uploaded.kind === "failed") {
    return { ok: false, message: uploaded.outcome.message };
  }

  let res: Response;
  try {
    res = await accountFetch(h, TRANSCRIBE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ path: uploaded.path }),
      signal,
    }, { budget: "transcribe", fetchImpl: fetchFn });
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, message: isDeadline(e) ? SLOW_COPY : TRANSCRIBE_FAILED_COPY };
  }
  if (!res.ok) return { ok: false, message: TRANSCRIBE_FAILED_COPY };
  try {
    const body = await accountJson<{ text?: unknown; ms?: unknown }>(h, res);
    if (typeof body.text !== "string") return { ok: false, message: TRANSCRIBE_FAILED_COPY };
    return { ok: true, text: body.text, ms: typeof body.ms === "number" ? body.ms : 0 };
  } catch (e) {
    rethrowAccountChanged(e);
    // The budget covers the body too, so the read itself can run out of it.
    return { ok: false, message: isDeadline(e) ? SLOW_COPY : TRANSCRIBE_FAILED_COPY };
  }
}
