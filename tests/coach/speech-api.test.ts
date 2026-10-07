/**
 * T7 §1 and §5 — feature detection at PRESS time, and the adapter over `SpeechRecognition`.
 *
 * The spec's Safari facts are the reason each of these exists: a phone that lost the API mid
 * session must fall to §2 on the NEXT press, and a `continuous` session that re-delivers its
 * whole result list must not append the same final twice.
 */
import { describe, expect, it, vi } from "vitest";
import {
  hasMediaRecorder, newSegments, speechRecognitionCtor, startListening,
} from "@/lib/coach/speech-api";

/** The shape the browser hands `onresult`, built the way a stub or Safari would. */
function resultEvent(
  results: { transcript: string; isFinal: boolean }[], resultIndex = 0,
): { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> } {
  const list = results.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal }));
  return { resultIndex, results: list as never };
}

class FakeRecognition {
  lang = "";
  interimResults = false;
  continuous = false;
  maxAlternatives = 0;
  started = 0;
  stopped = 0;
  aborted = 0;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start(): void { this.started += 1; }
  stop(): void { this.stopped += 1; }
  abort(): void { this.aborted += 1; }
}

describe("feature detection", () => {
  it("finds the standard constructor", () => {
    expect(speechRecognitionCtor({ SpeechRecognition: FakeRecognition as never })).not.toBeNull();
  });

  it("finds Safari's webkit constructor", () => {
    expect(speechRecognitionCtor({ webkitSpeechRecognition: FakeRecognition as never })).not.toBeNull();
  });

  it("answers null when the API is absent, so the press falls to the server fallback", () => {
    expect(speechRecognitionCtor({})).toBeNull();
    expect(startListening({ onSegment: vi.fn(), onError: vi.fn(), onEnd: vi.fn() }, {})).toBeNull();
  });

  it("reports MediaRecorder separately: with neither, the mic is hidden", () => {
    expect(hasMediaRecorder({})).toBe(false);
    expect(hasMediaRecorder({ MediaRecorder: function MediaRecorder() {} as never })).toBe(true);
  });
});

describe("startListening", () => {
  const scopeWith = (recognition: FakeRecognition, language = "en-GB") => ({
    SpeechRecognition: (function () { return recognition; }) as never,
    navigator: { language },
  });

  it("builds the recognition at press time with the four settings §1 names", () => {
    const recognition = new FakeRecognition();
    startListening({ onSegment: vi.fn(), onError: vi.fn(), onEnd: vi.fn() }, scopeWith(recognition));
    expect(recognition.lang).toBe("en-GB");
    expect(recognition.interimResults).toBe(true);
    expect(recognition.continuous).toBe(true);
    expect(recognition.maxAlternatives).toBe(1);
    expect(recognition.started).toBe(1);
  });

  it("passes each segment on as it lands, interim then final", () => {
    const recognition = new FakeRecognition();
    const onSegment = vi.fn();
    startListening({ onSegment, onError: vi.fn(), onEnd: vi.fn() }, scopeWith(recognition));
    recognition.onresult?.(resultEvent([{ transcript: "add water", isFinal: false }]));
    recognition.onresult?.(resultEvent([{ transcript: "add watermelon", isFinal: true }]));
    expect(onSegment.mock.calls.map(([s]) => s)).toEqual([
      { text: "add water", final: false },
      { text: "add watermelon", final: true },
    ]);
  });

  it("never repeats a final the API re-delivers in a later result list", () => {
    const recognition = new FakeRecognition();
    const onSegment = vi.fn();
    startListening({ onSegment, onError: vi.fn(), onEnd: vi.fn() }, scopeWith(recognition));
    const first = [{ transcript: "add watermelon", isFinal: true }];
    recognition.onresult?.(resultEvent(first));
    recognition.onresult?.(resultEvent([...first, { transcript: "to my list", isFinal: false }]));
    expect(onSegment.mock.calls.map(([s]) => s)).toEqual([
      { text: "add watermelon", final: true },
      { text: "to my list", final: false },
    ]);
  });

  it("reports the error code, unwrapped, and ends the session", () => {
    const recognition = new FakeRecognition();
    const onError = vi.fn();
    const onEnd = vi.fn();
    startListening({ onSegment: vi.fn(), onError, onEnd }, scopeWith(recognition));
    recognition.onerror?.({ error: "network" });
    recognition.onend?.();
    expect(onError).toHaveBeenCalledWith("network");
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("stops and aborts through the handle, and says nothing after it is let go", () => {
    const recognition = new FakeRecognition();
    const onSegment = vi.fn();
    const session = startListening({ onSegment, onError: vi.fn(), onEnd: vi.fn() },
      scopeWith(recognition));
    session?.stop();
    expect(recognition.stopped).toBe(1);
    session?.abort();
    expect(recognition.aborted).toBe(1);
    recognition.onresult?.(resultEvent([{ transcript: "late", isFinal: true }]));
    expect(onSegment).not.toHaveBeenCalled();
  });

  it("falls back to en-US when the platform has no language", () => {
    const recognition = new FakeRecognition();
    startListening({ onSegment: vi.fn(), onError: vi.fn(), onEnd: vi.fn() },
      { SpeechRecognition: (function () { return recognition; }) as never });
    expect(recognition.lang).toBe("en-US");
  });
});

describe("newSegments", () => {
  it("reads only from resultIndex onward", () => {
    const event = resultEvent([
      { transcript: "one", isFinal: true }, { transcript: "two", isFinal: false },
    ], 1);
    expect(newSegments(event, new Set())).toEqual([{ index: 1, text: "two", final: false }]);
  });

  it("skips an index already reported as final", () => {
    const event = resultEvent([{ transcript: "one", isFinal: true }]);
    expect(newSegments(event, new Set([0]))).toEqual([]);
  });
});
