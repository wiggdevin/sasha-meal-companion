"use client";

/**
 * The three I/O ports every tap-to-dictate control hands `HoldController` (lib/coach/hold.ts):
 * listen (the on-device recogniser, lib/coach/speech-api.ts), record (lib/capture-mic.ts) and
 * transcribe (the server fallback, lib/coach-transcribe-client.ts).
 *
 * One builder, so the coach composer's mic and the capture sheet's description box pick their
 * listener by the same rule: in a browser tab the on-device recogniser first, then the recorder;
 * in the installed app (home-screen PWA) the recorder only, because `webkitSpeechRecognition` is
 * unreliable there. `null` from `listen` is what makes the controller record instead (T7 §2).
 */

import type { HoldIo } from "@/lib/coach/hold-ports";
import { startListening } from "@/lib/coach/speech-api";
import { openMicRecorder } from "@/lib/capture-mic";
import { transcribeClip } from "@/lib/coach-transcribe-client";

type Scope = {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: { standalone?: boolean };
};

/** A home-screen PWA: the standard display-mode query, or iOS's own `navigator.standalone`. */
export function isStandalone(scope: Scope = globalThis as Scope): boolean {
  try {
    if (scope.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch { /* no matchMedia */ }
  return scope.navigator?.standalone === true;
}

export function dictationIo(): HoldIo {
  return {
    listen: (handlers) => (isStandalone() ? null : startListening(handlers)),
    record: (handlers) => openMicRecorder(handlers),
    transcribe: (clip, signal) => transcribeClip(clip, { signal }),
  };
}
