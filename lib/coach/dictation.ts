/**
 * Tap to record, as a pure state machine — T7 §1 and §3.
 *
 * `idle → listening → finalising → sent | empty | error`. The 800 ms finalise timer arrives as an
 * event, so the whole session is testable without a browser, a timer or a microphone.
 *
 * Nothing here talks to `SpeechRecognition` (lib/coach/speech-api.ts does) and nothing here sends
 * a turn (the user's own Send does). This file only decides what the session heard.
 */

/** How long after Stop the API is given to deliver one last final result. */
export const FINALISE_MS = 800;
/** How long the empty-transcript line stands under the composer. */
export const EMPTY_MS = 3_000;

export const EMPTY_COPY = "I did not catch that. Tap Record to try again.";
export const NO_SPEECH_COPY = "I did not hear anything. Tap Record to try again.";
/**
 * The same sentence `components/VoiceCapture.tsx` already shows for a denied microphone (§3).
 * It is repeated rather than imported because this module is pure and must not pull a React
 * component into the state machine's graph; tests/coach/dictation.test.ts asserts the two agree.
 */
export const PERMISSION_COPY = "Microphone access is off. Allow it in Settings, then try again.";
/** §2: the server fallback ran out of its 8 s budget. */
export const SLOW_COPY = "Transcribing is slow right now. Type it, or try again.";

/**
 * The three recognition errors §3 answers by switching this session to the server fallback and
 * saying nothing: the next press records instead of listening. A page reload tries on-device again.
 */
export const FALLBACK_ERRORS: readonly string[] = ["network", "service-not-allowed", "audio-capture"];

/** Raised by our own `stop()`; it is the end of a session, not a failure. */
const IGNORED_ERRORS: readonly string[] = ["aborted"];

const PERMISSION_ERRORS: readonly string[] = ["not-allowed", "NotAllowedError"];

export type DictationPhase = "idle" | "listening" | "finalising" | "sent" | "empty" | "error";

/** A line under the composer and how long it stands. `ms` of 0 stands until the next press. */
export type DictationNotice = { text: string; ms: number };

export type DictationState = {
  phase: DictationPhase;
  /** The final segments, in the order they landed. */
  finals: readonly string[];
  /** The segment still being revised. */
  interim: string;
  notice: DictationNotice | null;
  /** On `sent`, the transcript to send as one turn. Empty everywhere else. */
  text: string;
  /** This session has fallen back to §2: the next press records rather than listening. */
  fallback: boolean;
};

export type DictationEvent =
  | { type: "press" }
  | { type: "segment"; text: string; final: boolean }
  | { type: "release" }
  /** The FINALISE_MS timer fired with nothing more from the API. */
  | { type: "finalised" }
  | { type: "error"; code: string }
  /** The caller has read `text` and sent (or shown) it. */
  | { type: "settled" }
  | { type: "notice_expired" };

export function initialDictation(fallback = false): DictationState {
  return { phase: "idle", finals: [], interim: "", notice: null, text: "", fallback };
}

/** What the user said so far: the final segments joined, then the segment still being revised (§1). */
export function transcriptOf(state: DictationState): string {
  return [...state.finals, state.interim].map((part) => part.trim()).filter(Boolean).join(" ");
}

/** The end of a session: what was heard becomes a turn, or the empty line. */
function settle(state: DictationState): DictationState {
  const text = transcriptOf(state);
  const cleared = { ...state, finals: [], interim: "" };
  if (text.length === 0) {
    return { ...cleared, phase: "empty", text: "", notice: { text: EMPTY_COPY, ms: EMPTY_MS } };
  }
  return { ...cleared, phase: "sent", text, notice: null };
}

function heard(state: DictationState, event: { text: string; final: boolean }): DictationState {
  return event.final
    ? { ...state, finals: [...state.finals, event.text], interim: "" }
    : { ...state, interim: event.text };
}

function failed(state: DictationState, code: string): DictationState {
  if (IGNORED_ERRORS.includes(code)) return state;
  // An error the spec names copy for is theirs to read and fix; anything else — including an error
  // nobody planned for — is a reason to use the server instead, silently.
  if (PERMISSION_ERRORS.includes(code)) {
    return { ...initialDictation(state.fallback), phase: "error",
      notice: { text: PERMISSION_COPY, ms: 0 } };
  }
  if (code === "no-speech") {
    // Safari raises `no-speech` after a pause, mid-session, with sentences already final. Those are
    // their words: they finalise normally, and only a session that heard NOTHING gets the line
    // (panel round 1, HIGH 5).
    if (transcriptOf(state).length > 0) return settle(state);
    return { ...initialDictation(state.fallback), phase: "error",
      notice: { text: NO_SPEECH_COPY, ms: 0 } };
  }
  return initialDictation(true);
}

export function nextDictation(state: DictationState, event: DictationEvent): DictationState {
  switch (event.type) {
    case "press":
      return { ...initialDictation(state.fallback), phase: "listening" };
    case "segment": {
      if (state.phase !== "listening" && state.phase !== "finalising") return state;
      const next = heard(state, event);
      // The last final after Stop is what the wait in `finalising` was for.
      return state.phase === "finalising" && event.final ? settle(next) : next;
    }
    case "release": {
      if (state.phase !== "listening") return state;
      // Nothing is pending when every segment has been finalised, so there is no reason to spend
      // the finalise timer waiting for an API that has already said everything it is going to.
      return state.interim === "" && state.finals.length > 0
        ? settle(state)
        : { ...state, phase: "finalising" };
    }
    case "finalised":
      return state.phase === "finalising" ? settle(state) : state;
    case "error":
      return failed(state, event.code);
    case "settled":
      return { ...initialDictation(state.fallback), notice: state.notice };
    case "notice_expired":
      return { ...state, notice: null };
  }
}
