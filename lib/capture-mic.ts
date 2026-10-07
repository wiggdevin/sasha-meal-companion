/**
 * The microphone, once, for both surfaces that hold a button to record.
 *
 * `components/VoiceCapture.tsx` (the FAB's voice note) and the coach's voice fallback
 * (`lib/coach-transcribe-client.ts`, T7 §2) open the same microphone under the same rules: the
 * bucket's own mime types, a 30 s hard stop, and the two failures the user is told apart. This module
 * is where that lives, so a `lib/` module never has to import a component to get at it.
 *
 * TIMESLICE: `MediaRecorder.start()` with no argument buffers the whole clip and, on iOS, has
 * been observed to deliver an EMPTY blob when the recorder is stopped quickly. Starting with a
 * timeslice makes the recorder hand over a chunk every quarter second, so a short hold still ends
 * with bytes in it.
 */

import { pickAudioMimeType } from "@/lib/capture/presentation";

/** The two ways opening the microphone can fail — kept distinct so the user is told which one it was
 *  (audit #73): a denied permission is theirs to fix in Settings, a true device/codec gap is not. */
export type MicFailureReason = "unsupported" | "permission-denied";

/**
 * `getUserMedia` rejects with a `DOMException` named `NotAllowedError` when the prompt is
 * dismissed or the permission was already denied; every other rejection (no device, `NotFoundError`,
 * etc.) is a real capability gap. Duck-typed on `.name` rather than `instanceof DOMException` so a
 * plain object with that name (as a test, or a non-browser environment, would produce) still
 * classifies correctly.
 */
export function classifyMicError(error: unknown): MicFailureReason {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === "NotAllowedError" ? "permission-denied" : "unsupported";
}

const UNSUPPORTED_COPY: Record<MicFailureReason, string> = {
  unsupported: "This phone will not record here. Type it instead, or use search.",
  "permission-denied": "Microphone access is off. Allow it in Settings, then try again.",
};

export function unsupportedCopy(reason: MicFailureReason): string {
  return UNSUPPORTED_COPY[reason];
}

/** The hard stop. The server refuses a longer clip, and the countdown is the only warning. */
export const MAX_RECORDING_SECONDS = 30;
/** How often the recorder hands over what it has. See TIMESLICE above. */
export const RECORDER_TIMESLICE_MS = 250;
const TICK_MS = 100;

export type MicRecorder = {
  /** End the clip and deliver it through `onClip`. */
  stop: () => void;
  /** End the clip and throw it away — a hold that turned out not to want it. */
  cancel: () => void;
  mimeType: string;
};

export type MicHandlers = {
  onClip: (clip: Blob) => void;
  onFailure: (reason: MicFailureReason, copy: string) => void;
  onElapsed?: (seconds: number) => void;
};

type MicScope = {
  MediaRecorder?: {
    new (stream: MediaStream, options: { mimeType: string }): MediaRecorder;
    isTypeSupported: (type: string) => boolean;
  };
  navigator?: { mediaDevices?: { getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream> } };
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

/**
 * Open the microphone and start recording, or report why not. The caller holds the handle: `stop`
 * delivers the clip, `cancel` drops it, and the 30 s ceiling calls `stop` itself.
 */
export async function openMicRecorder(
  handlers: MicHandlers, scope: MicScope = globalThis as MicScope,
): Promise<MicRecorder | null> {
  const Recorder = scope.MediaRecorder;
  const mimeType = pickAudioMimeType(
    (type) => Recorder !== undefined && Recorder.isTypeSupported(type),
  );
  const devices = scope.navigator?.mediaDevices;
  if (Recorder === undefined || mimeType === null || devices === undefined) {
    handlers.onFailure("unsupported", unsupportedCopy("unsupported"));
    return null;
  }

  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia({ audio: true });
  } catch (error) {
    const reason = classifyMicError(error);
    handlers.onFailure(reason, unsupportedCopy(reason));
    return null;
  }

  const chunks: Blob[] = [];
  const media = new Recorder(stream, { mimeType });
  let wanted = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  const clearTick = (): void => {
    if (timer !== null) (scope.clearInterval ?? clearInterval)(timer);
    timer = null;
  };
  media.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  media.onstop = () => {
    clearTick();
    for (const track of stream.getTracks()) track.stop();
    if (wanted) handlers.onClip(new Blob(chunks, { type: mimeType }));
  };
  media.start(RECORDER_TIMESLICE_MS);

  const end = (): void => {
    clearTick();
    if (media.state === "recording") media.stop();
  };
  const startedAt = Date.now();
  timer = (scope.setInterval ?? setInterval)(() => {
    const seconds = (Date.now() - startedAt) / 1000;
    handlers.onElapsed?.(seconds);
    if (seconds >= MAX_RECORDING_SECONDS) end();
  }, TICK_MS);
  return {
    mimeType,
    stop: end,
    cancel: () => { wanted = false; end(); },
  };
}
