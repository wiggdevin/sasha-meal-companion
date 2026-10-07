/**
 * The browser's own speech recognition, behind one thin adapter — T7 §1.
 *
 * Detection happens HERE and at press time, never at load: iOS Safari is known to lose
 * `webkitSpeechRecognition` in some home-screen (standalone) builds, so a phone that had it a
 * minute ago may not have it now, and the next press must fall to §2 rather than throw (§5).
 *
 * The adapter exists so a test — and the panel — can hand in a scope with a stubbed constructor
 * and drive a whole hold without a microphone.
 */

export type SpeechSegment = { text: string; final: boolean };

/** What we use of `SpeechRecognitionEvent`: the new results and where they start. */
export type SpeechResultEvent = {
  resultIndex?: number;
  results: ArrayLike<ArrayLike<{ transcript?: string }> & { isFinal?: boolean }>;
};

export type RecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onstart?: (() => void) | null;
};

type RecognitionCtor = new () => RecognitionLike;

/** The globals this module reads. A test passes its own; the browser passes `globalThis`. */
export type SpeechScope = {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
  MediaRecorder?: unknown;
  navigator?: { language?: string };
};

export type SpeechHandlers = {
  onSegment: (segment: SpeechSegment) => void;
  onError: (code: string) => void;
  onEnd: () => void;
  /** The microphone actually opened. Until this has fired, a hold that ended was the permission
   *  prompt lifting their finger, not a silence (T7 §5, panel round 1). */
  onAudioStart?: () => void;
};

export type SpeechSession = {
  stop: () => void;
  abort: () => void;
};

const DEFAULT_LANG = "en-US";

/** The constructor this platform has RIGHT NOW, standard name first, Safari's second. */
export function speechRecognitionCtor(
  scope: SpeechScope = globalThis as SpeechScope,
): RecognitionCtor | null {
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** §3: with neither API the mic is hidden altogether, so the fallback's half is asked separately. */
export function hasMediaRecorder(scope: SpeechScope = globalThis as SpeechScope): boolean {
  return typeof scope.MediaRecorder === "function";
}

/**
 * §3's last row: with neither API there is nothing to hold, so the mic is not rendered at all and
 * the composer's placeholder is unchanged.
 */
export function micAvailable(scope: SpeechScope = globalThis as SpeechScope): boolean {
  return speechRecognitionCtor(scope) !== null || hasMediaRecorder(scope);
}

/**
 * The results of one `onresult` event that have not been reported yet.
 *
 * `continuous` mode re-delivers earlier results inside later events, so an index already reported
 * as final is skipped: without this, one sentence lands in the transcript twice.
 */
export function newSegments(
  event: SpeechResultEvent, alreadyFinal: ReadonlySet<number>,
): { index: number; text: string; final: boolean }[] {
  const out: { index: number; text: string; final: boolean }[] = [];
  const from = typeof event.resultIndex === "number" ? event.resultIndex : 0;
  for (let index = from; index < event.results.length; index += 1) {
    const result = event.results[index];
    const final = result?.isFinal === true;
    if (final && alreadyFinal.has(index)) continue;
    out.push({ index, text: result?.[0]?.transcript ?? "", final });
  }
  return out;
}

/**
 * Start listening, or answer `null` when this platform cannot. The recognition object is built
 * here — per press, never kept — with the four settings §1 fixes.
 */
export function startListening(
  handlers: SpeechHandlers, scope: SpeechScope = globalThis as SpeechScope,
): SpeechSession | null {
  const Ctor = speechRecognitionCtor(scope);
  if (Ctor === null) return null;
  const recognition = new Ctor();
  recognition.lang = scope.navigator?.language ?? DEFAULT_LANG;
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  const alreadyFinal = new Set<number>();
  let live = true;
  recognition.onresult = (event) => {
    if (!live) return;
    for (const segment of newSegments(event, alreadyFinal)) {
      if (segment.final) alreadyFinal.add(segment.index);
      handlers.onSegment({ text: segment.text, final: segment.final });
    }
  };
  recognition.onerror = (event) => { if (live) handlers.onError(event.error ?? "unknown"); };
  recognition.onend = () => {
    if (!live) return;
    live = false;
    handlers.onEnd();
  };
  let opened = false;
  const audioStarted = (): void => {
    if (!live || opened) return;
    opened = true;
    handlers.onAudioStart?.();
  };
  recognition.onaudiostart = audioStarted;
  recognition.onstart = audioStarted;
  try {
    recognition.start();
  } catch (e) {
    // Safari throws InvalidStateError when a recogniser is started twice, and a throw here would
    // otherwise leave the caller holding a session that never ends (panel round 1, LOW 22).
    live = false;
    handlers.onError(e instanceof Error && e.name ? e.name : "start-failed");
    return null;
  }

  /**
   * `stop()` ENDS the utterance; it does not end the session. WebKit delivers the last final
   * result AFTER stop(), and dropping the handlers there threw away the very words the hold was
   * for (panel round 1, HIGH 1). So stop() leaves everything live until `onend`, and only
   * `abort()` — which throws the utterance away on purpose — lets go at once.
   */
  return {
    stop: () => { recognition.stop(); },
    abort: () => { live = false; recognition.abort(); },
  };
}
